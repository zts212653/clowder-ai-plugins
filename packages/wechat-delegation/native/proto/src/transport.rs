//! The protocol subset's only production network construction site.
//! Targets and HTTP routes cannot be supplied through the connection IPC.
use anyhow::{ensure, Result};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressRecord {
    pub host: String,
    pub port: u16,
    pub resolved_ips: Vec<String>,
    pub long_connections: u64,
    pub long_bytes_written: u64,
    pub long_bytes_read: u64,
    pub short_requests: u64,
    // HTTP body bytes prepared/read, not kernel-level wire counters or proof
    // of server receipt. Headers and interrupted partial writes are excluded.
    pub short_body_bytes_prepared: u64,
    pub short_response_body_bytes_read: u64,
    pub system_fake_ip_observed: bool,
    pub verified_pin_versions: Vec<u32>,
    pub verified_regions: Vec<u32>,
}
static RECORDS: OnceLock<Mutex<BTreeMap<String, EgressRecord>>> = OnceLock::new();

fn record(host: &str, update: impl FnOnce(&mut EgressRecord)) -> io::Result<()> {
    let mut records = RECORDS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| io::Error::other("network observation unavailable"))?;
    let value = records.entry(host.into()).or_insert_with(|| EgressRecord {
        host: host.into(),
        port: 80,
        ..Default::default()
    });
    update(value);
    Ok(())
}
pub fn egress_snapshot() -> Result<Vec<EgressRecord>> {
    Ok(RECORDS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| anyhow::anyhow!("network observation unavailable"))?
        .values()
        .cloned()
        .collect())
}

fn permitted_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            // Fake-IP routing is an observed owner system setting, not proof
            // that a Tencent endpoint was reached. It remains visible above.
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || a == 100 && (64..=127).contains(&b)
                || a == 169 && b == 254
                || a == 172 && (16..=31).contains(&b)
                || a == 192 && (b == 168 || b == 0 && (c == 0 || c == 2))
                || a == 198 && b == 51 && c == 100
                || a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4() {
                return permitted_ip(IpAddr::V4(v4));
            }
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
                && !(ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
        }
    }
}
fn resolve(host: &str) -> Result<Vec<SocketAddr>> {
    crate::mmtls::validate_host(host)?;
    let addresses: Vec<_> = (host, 80)
        .to_socket_addrs()?
        .filter(|a| permitted_ip(a.ip()))
        .collect();
    ensure!(!addresses.is_empty(), "No permitted WeChat endpoint");
    record(host, |value| {
        for address in &addresses {
            let ip = address.ip().to_string();
            if !value.resolved_ips.contains(&ip) && value.resolved_ips.len() < 64 {
                value.resolved_ips.push(ip);
            }
            if let IpAddr::V4(ip) = address.ip() {
                let [a, b, _, _] = ip.octets();
                value.system_fake_ip_observed |= a == 198 && (b == 18 || b == 19);
            }
        }
    })?;
    Ok(addresses)
}

pub(crate) struct OfficialStream {
    inner: TcpStream,
    host: String,
}
impl OfficialStream {
    pub(crate) fn record_verified_peer(&self, version: u32, region: u32) -> io::Result<()> {
        record(&self.host, |value| {
            if !value.verified_pin_versions.contains(&version)
                && value.verified_pin_versions.len() < 8
            {
                value.verified_pin_versions.push(version);
            }
            if !value.verified_regions.contains(&region) && value.verified_regions.len() < 8 {
                value.verified_regions.push(region);
            }
        })
    }
    pub(crate) fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.inner.set_read_timeout(timeout)
    }
    pub(crate) fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.inner.set_write_timeout(timeout)
    }
    #[cfg(test)]
    pub(crate) fn synthetic(inner: TcpStream) -> Self {
        assert!(inner.peer_addr().unwrap().ip().is_loopback());
        Self {
            inner,
            host: "synthetic.wechat.com".into(),
        }
    }
}
impl Read for OfficialStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(bytes)?;
        record(&self.host, |v| {
            v.long_bytes_read = v.long_bytes_read.saturating_add(count as u64)
        })?;
        Ok(count)
    }
}
impl Write for OfficialStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = self.inner.write(bytes)?;
        record(&self.host, |v| {
            v.long_bytes_written = v.long_bytes_written.saturating_add(count as u64)
        })?;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}
pub(crate) fn connect(host: &str, timeout: Duration) -> Result<OfficialStream> {
    let addresses = resolve(host)?;
    let deadline = Instant::now() + timeout;
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(inner) = TcpStream::connect_timeout(&address, remaining) {
            record(host, |value| {
                value.long_connections = value.long_connections.saturating_add(1)
            })?;
            return Ok(OfficialStream {
                inner,
                host: host.into(),
            });
        }
    }
    anyhow::bail!("WeChat connection failed")
}

pub(crate) fn post_mmtls(host: &str, body: Vec<u8>, timeout: Duration) -> Result<Vec<u8>> {
    let addresses = resolve(host)?;
    post_at(host, &addresses, body, timeout)
}
fn post_at(
    host: &str,
    addresses: &[SocketAddr],
    body: Vec<u8>,
    timeout: Duration,
) -> Result<Vec<u8>> {
    crate::mmtls::validate_host(host)?;
    ensure!(
        body.len() <= crate::MAX_MESSAGE_BYTES + 65536,
        "MMTLS request exceeds bound"
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout.min(Duration::from_secs(10)))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        // Pin this request to the checked resolution; a second DNS lookup must
        // not introduce a local/private address after the check.
        .resolve_to_addrs(host, addresses)
        .build()?;
    record(host, |v| {
        v.short_requests = v.short_requests.saturating_add(1);
        v.short_body_bytes_prepared = v
            .short_body_bytes_prepared
            .saturating_add(body.len() as u64);
    })?;
    let mut response = client
        .post(format!(
            "http://{host}/mmtls/{}",
            hex::encode(crate::crypto::random::<4>()?)
        ))
        .header("Content-Type", "application/octet-stream")
        .header("User-Agent", "MicroMessenger Client")
        .header("Upgrade", "mmtls")
        .header("Accept", "*/*")
        .header("Cache-Control", "no-cache")
        .header("Connection", "close")
        .body(body)
        .send()?;
    ensure!(
        response.status() == 200,
        "WeChat shortlink HTTP status {}",
        response.status().as_u16()
    );
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take((crate::MAX_MESSAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    record(host, |v| {
        v.short_response_body_bytes_read = v
            .short_response_body_bytes_read
            .saturating_add(bytes.len() as u64)
    })?;
    ensure!(
        bytes.len() <= crate::MAX_MESSAGE_BYTES,
        "Shortlink receive budget exceeded"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_mapped_and_metadata_targets_are_not_permitted() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.2",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fe80::1",
            "fc00::1",
            "2001:db8::1",
        ] {
            assert!(
                !permitted_ip(ip.parse().unwrap()),
                "unexpected endpoint: {ip}"
            );
        }
        assert!(permitted_ip("198.18.0.6".parse().unwrap()));
        assert!(permitted_ip("1.1.1.1".parse().unwrap()));
    }
    #[test]
    fn hostile_hosts_fail_before_resolution_or_connection() {
        for host in [
            "localhost",
            "127.0.0.1",
            "long.weixin.qq.com.attacker.test",
            "x.wechat.com:80",
            "user@x.wechat.com",
        ] {
            assert!(connect(host, Duration::from_millis(50)).is_err());
            assert!(post_mmtls(host, vec![1], Duration::from_millis(50)).is_err());
        }
    }
    #[test]
    fn redirect_is_not_followed_by_the_production_http_path() {
        use std::{net::TcpListener, thread};
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let trap = TcpListener::bind("127.0.0.1:0").unwrap();
        trap.set_nonblocking(true).unwrap();
        let destination = trap.local_addr().unwrap();
        let address = origin.local_addr().unwrap();
        origin.set_nonblocking(true).unwrap();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let (mut stream, _) = loop {
                match origin.accept() {
                    Ok(peer) => break peer,
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("synthetic origin did not receive the request: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).unwrap();
            write!(stream,"HTTP/1.1 302 Found\r\nLocation: http://{destination}/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let error = post_at(
            "short.weixin.qq.com",
            &[address],
            vec![0; 16],
            Duration::from_secs(2),
        )
        .unwrap_err();
        server.join().unwrap();
        assert!(error.to_string().contains("HTTP status 302"), "{error}");
        assert_eq!(trap.accept().unwrap_err().kind(), io::ErrorKind::WouldBlock);
    }
}
