//! Owner-scoped LAN token responder. It has no account authority or inbound
//! parser, never binds a wildcard, and never learns a token before its upload.
use std::{
    ffi::CStr,
    io::{self, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use wechat_protocol::LoginGuard;
use zeroize::Zeroizing;
type Result<T> = std::result::Result<T, ()>;
const TICK: Duration = Duration::from_millis(20);

#[derive(Clone, Copy)]
struct Endpoint {
    address: Ipv4Addr,
    mask: u32,
}
impl Endpoint {
    fn selected(name: &[u8], flags: u32, address: Ipv4Addr, mask: u32) -> Option<Self> {
        let required = (libc::IFF_UP | libc::IFF_BROADCAST) as u32;
        if !name.starts_with(b"en")
            || name.len() == 2
            || !name[2..].iter().all(u8::is_ascii_digit)
            || flags & required != required
            || flags & (libc::IFF_LOOPBACK | libc::IFF_POINTOPOINT) as u32 != 0
        {
            return None;
        }
        let octets = address.octets();
        let minimum = if octets[0] == 10 {
            8
        } else if octets[0] == 172 && (16..=31).contains(&octets[1]) {
            12
        } else if octets[0] == 192 && octets[1] == 168 {
            16
        } else {
            return None;
        };
        let prefix = mask.leading_ones();
        if prefix < minimum || prefix > 30 || prefix + mask.trailing_zeros() != 32 {
            return None;
        }
        let endpoint = Self { address, mask };
        endpoint.permits(address).then_some(endpoint)
    }
    fn permits(&self, source: Ipv4Addr) -> bool {
        let network = u32::from(self.address) & self.mask;
        let value = u32::from(source);
        value & self.mask == network && value != network && value != (network | !self.mask)
    }
}
fn interfaces() -> Result<Vec<Endpoint>> {
    let mut first = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut first) } != 0 {
        return Err(());
    }
    struct Addresses(*mut libc::ifaddrs);
    impl Drop for Addresses {
        fn drop(&mut self) {
            unsafe { libc::freeifaddrs(self.0) }
        }
    }
    let _addresses = Addresses(first);
    let mut selected = std::collections::BTreeMap::new();
    let mut next = first;
    while !next.is_null() {
        let item = unsafe { &*next };
        next = item.ifa_next;
        if item.ifa_addr.is_null()
            || item.ifa_netmask.is_null()
            || item.ifa_name.is_null()
            || unsafe { (*item.ifa_addr).sa_family as i32 } != libc::AF_INET
        {
            continue;
        }
        let name = unsafe { CStr::from_ptr(item.ifa_name) }.to_bytes();
        let address = unsafe { &*item.ifa_addr.cast::<libc::sockaddr_in>() };
        let mask = unsafe { &*item.ifa_netmask.cast::<libc::sockaddr_in>() };
        if let Some(endpoint) = Endpoint::selected(
            name,
            item.ifa_flags,
            Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr)),
            u32::from_be(mask.sin_addr.s_addr),
        ) {
            selected.insert(endpoint.address, endpoint);
        }
    }
    if selected.is_empty() || selected.len() > 8 {
        return Err(());
    }
    Ok(selected.into_values().collect())
}
struct State {
    stop: AtomicBool,
    done: AtomicBool,
    guard: LoginGuard,
}
impl State {
    fn active(&self) -> bool {
        !self.stop.load(Ordering::Acquire) && !self.guard.interrupted()
    }
}
pub(super) struct LanChallenge {
    addresses: Vec<Ipv4Addr>,
    port: u16,
    state: Arc<State>,
    token: Mutex<Option<mpsc::SyncSender<Zeroizing<Vec<u8>>>>>,
    worker: Option<JoinHandle<()>>,
}
impl LanChallenge {
    pub(super) fn bind(guard: LoginGuard) -> Result<Self> {
        if guard.interrupted() {
            return Err(());
        }
        let endpoints = interfaces()?;
        for port in 8050..=8100 {
            if guard.interrupted() {
                return Err(());
            }
            let mut listeners = Vec::new();
            for endpoint in &endpoints {
                match TcpListener::bind((endpoint.address, port)) {
                    Ok(listener) => listeners.push((listener, *endpoint)),
                    Err(error) if error.kind() == io::ErrorKind::AddrInUse => break,
                    Err(_) => return Err(()),
                }
            }
            if listeners.len() == endpoints.len() {
                return Self::from_listeners(listeners, guard);
            }
        }
        Err(())
    }
    fn from_listeners(listeners: Vec<(TcpListener, Endpoint)>, guard: LoginGuard) -> Result<Self> {
        if guard.interrupted() || listeners.is_empty() {
            return Err(());
        }
        for (listener, _) in &listeners {
            listener.set_nonblocking(true).map_err(|_| ())?;
        }
        let port = listeners[0].0.local_addr().map_err(|_| ())?.port();
        let addresses = listeners
            .iter()
            .map(|(_, endpoint)| endpoint.address)
            .collect();
        let state = Arc::new(State {
            stop: AtomicBool::new(false),
            done: AtomicBool::new(false),
            guard,
        });
        let shared = state.clone();
        let (token, incoming) = mpsc::sync_channel::<Zeroizing<Vec<u8>>>(1);
        let worker = thread::Builder::new()
            .name("clowder-wechat-lan".into())
            .spawn(move || {
                let frame = loop {
                    if !shared.active() {
                        drop(listeners);
                        shared.done.store(true, Ordering::Release);
                        return;
                    }
                    match incoming.recv_timeout(TICK) {
                        Ok(frame) => break frame,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => {
                            drop(listeners);
                            shared.done.store(true, Ordering::Release);
                            return;
                        }
                    }
                };
                let mut accepted = 0;
                while shared.active() && accepted < 32 {
                    for (listener, endpoint) in &listeners {
                        if !shared.active() || accepted >= 32 {
                            break;
                        }
                        match listener.accept() {
                            Ok((mut stream, SocketAddr::V4(source))) => {
                                accepted += 1;
                                if endpoint.permits(*source.ip()) {
                                    let _ = write_frame(&mut stream, &frame, &shared);
                                }
                            }
                            Ok(_) => {
                                accepted += 1;
                            }
                            Err(error)
                                if matches!(
                                    error.kind(),
                                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                                ) => {}
                            Err(_) => {
                                shared.stop.store(true, Ordering::Release);
                                break;
                            }
                        }
                    }
                    thread::sleep(TICK);
                }
                drop(listeners);
                shared.done.store(true, Ordering::Release);
            })
            .map_err(|_| ())?;
        Ok(Self {
            addresses,
            port,
            state,
            token: Mutex::new(Some(token)),
            worker: Some(worker),
        })
    }
    pub(super) fn endpoint(&self) -> (&[Ipv4Addr], u16) {
        (&self.addresses, self.port)
    }
    pub(super) fn active(&self) -> bool {
        self.state.active() && !self.state.done.load(Ordering::Acquire)
    }
    pub(super) fn arm(&self, token: &[u8]) -> Result<()> {
        if !self.active() || token.is_empty() || token.len() > 4096 {
            return Err(());
        }
        let token = std::str::from_utf8(token).map_err(|_| ())?;
        #[derive(serde::Serialize)]
        struct Reply<'a> {
            scene: &'a str,
            token: &'a str,
        }
        let json = Zeroizing::new(
            serde_json::to_vec(&Reply {
                scene: "xwechat",
                token,
            })
            .map_err(|_| ())?,
        );
        let mut frame = Zeroizing::new(Vec::with_capacity(json.len() + 4));
        frame.extend_from_slice(&u32::try_from(json.len() + 4).map_err(|_| ())?.to_be_bytes());
        frame.extend_from_slice(&json);
        self.token
            .lock()
            .map_err(|_| ())?
            .take()
            .ok_or(())?
            .send(frame)
            .map_err(|_| ())
    }
}
impl Drop for LanChallenge {
    fn drop(&mut self) {
        self.state.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn write_frame(stream: &mut TcpStream, frame: &[u8], state: &State) -> io::Result<()> {
    stream.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut sent = 0;
    while sent < frame.len() {
        if !state.active() || Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        match stream.write(&frame[sent..]) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(count) => sent += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(TICK),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    fn synthetic(guard: LoginGuard) -> LanChallenge {
        // Only this test constructor binds loopback; production en* selection
        // requires private subnets. No actual LAN interface is enumerated.
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        LanChallenge::from_listeners(
            vec![(
                listener,
                Endpoint {
                    address: Ipv4Addr::LOCALHOST,
                    mask: 0xff000000,
                },
            )],
            guard,
        )
        .unwrap()
    }
    fn assert_closed(challenge: &LanChallenge) {
        // EOF is visible before the worker's final tick and listener drop.
        // Wait for that owned completion signal, with a real upper bound,
        // rather than treating a fixed sleep as a thread scheduling barrier.
        let deadline = Instant::now() + Duration::from_secs(1);
        while !challenge.state.done.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(TICK);
        }
        assert!(challenge.state.done.load(Ordering::Acquire));
        assert!(!challenge.active());
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, challenge.port)).is_err());
    }
    #[test]
    fn selected_endpoints_exclude_vpn_public_noncontiguous_and_wider_than_private_subnets() {
        let flags = (libc::IFF_UP | libc::IFF_BROADCAST) as u32;
        let ip = Ipv4Addr::new(192, 168, 5, 10);
        let endpoint = Endpoint::selected(b"en0", flags, ip, 0xffffff00).unwrap();
        assert!(endpoint.permits(Ipv4Addr::new(192, 168, 5, 11)));
        assert!(!endpoint.permits(Ipv4Addr::new(192, 168, 6, 11)));
        for source in [
            Ipv4Addr::new(192, 168, 5, 0),
            Ipv4Addr::new(192, 168, 5, 255),
        ] {
            assert!(!endpoint.permits(source));
        }
        for (name, address, mask, flags) in [
            (b"utun1".as_slice(), ip, 0xffffff00, flags),
            (b"en0", Ipv4Addr::new(198, 18, 0, 1), 0xffffff00, flags),
            (b"en0", ip, 0xff00ff00, flags),
            (b"en0", ip, 0xff000000, flags),
            (b"en0", ip, 0xffffff00, flags | libc::IFF_POINTOPOINT as u32),
        ] {
            assert!(Endpoint::selected(name, flags, address, mask).is_none());
        }
    }
    #[test]
    fn listener_writes_only_after_token_and_cancel_closes_it_independently_of_network_workers() {
        let guard = LoginGuard::new(Instant::now() + Duration::from_secs(5));
        let challenge = synthetic(guard.clone());
        let mut phone = TcpStream::connect((Ipv4Addr::LOCALHOST, challenge.port)).unwrap();
        phone
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        assert!(
            phone.read(&mut [0; 1]).is_err(),
            "no empty token before upload reply"
        );
        challenge.arm(b"SYNTHETIC_LAN_TOKEN").unwrap();
        phone
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut header = [0; 4];
        phone.read_exact(&mut header).unwrap();
        let mut body = vec![0; u32::from_be_bytes(header) as usize - 4];
        phone.read_exact(&mut body).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["scene"], "xwechat");
        assert_eq!(value["token"], "SYNTHETIC_LAN_TOKEN");
        assert!(challenge.arm(b"another").is_err());
        guard.cancel();
        assert_closed(&challenge);
    }
    #[test]
    fn deadline_and_connection_budget_close_the_actual_loopback_socket() {
        let expired = LoginGuard::new(Instant::now() + Duration::from_millis(80));
        let challenge = synthetic(expired);
        thread::sleep(Duration::from_millis(140));
        assert!(!challenge.active());
        assert_closed(&challenge);
        let challenge = synthetic(LoginGuard::new(Instant::now() + Duration::from_secs(60)));
        challenge.arm(b"SYNTHETIC_TOKEN").unwrap();
        for _ in 0..32 {
            let mut phone = TcpStream::connect((Ipv4Addr::LOCALHOST, challenge.port)).unwrap();
            phone
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut frame = Vec::new();
            phone.read_to_end(&mut frame).unwrap();
            assert!(!frame.is_empty());
        }
        assert_closed(&challenge);
    }
}
