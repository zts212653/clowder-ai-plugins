//! Fixed LAN verification codec, adapted from MIT agent-wechat ed976d7
//! lan_login.rs. No sockets, interface discovery, tokens in public projections,
//! or implicit permission. The connection service owns the temporary listener.
use crate::{protobuf as p, wire, DeviceProfile};
use anyhow::{ensure, Result};
use std::net::Ipv4Addr;
use zeroize::Zeroizing;

pub(super) fn request(
    device: &DeviceProfile,
    identifier: &[u8],
    addresses: &[Ipv4Addr],
    port: u16,
    random: &[u8; 16],
) -> Result<Vec<u8>> {
    ensure!(
        !identifier.is_empty() && identifier.len() <= 4096,
        "Invalid LAN login identifier"
    );
    ensure!(
        !addresses.is_empty()
            && addresses.len() <= 8
            && addresses.iter().all(Ipv4Addr::is_private)
            && (8050..=8100).contains(&port),
        "Invalid LAN endpoint scope"
    );
    let entries = addresses
        .iter()
        .map(|ip| {
            p::message(&[
                p::bytes(1, ip.to_string().as_bytes()),
                p::uint(2, u64::from(port)),
            ])
        })
        .collect::<Result<Vec<_>>>()?;
    let entries = entries
        .iter()
        .map(|entry| p::bytes(1, entry))
        .collect::<Vec<_>>();
    p::message(&[
        p::bytes(1, &wire::base_request(device, 0, 0)?),
        p::bytes(2, &p::message(&entries)?),
        p::bytes(3, identifier),
        p::bytes(4, &p::buffer(random)),
    ])
}
pub(super) fn token(input: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    ensure!(input.len() <= 16384, "LAN upload response too large");
    let fields = p::decode(input)?;
    ensure!(p::base_code(&fields)? == 0, "LAN upload rejected");
    let token = p::data(&fields, 2)?;
    ensure!(
        !token.is_empty() && token.len() <= 4096,
        "Invalid LAN token length"
    );
    std::str::from_utf8(token)?;
    Ok(Zeroizing::new(token.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_upload_codec_accepts_only_private_bounded_endpoints_and_a_valid_token() {
        let device = DeviceProfile::generate("UnifiedPCLinux synthetic x86_64".into()).unwrap();
        let address = Ipv4Addr::new(192, 168, 4, 10);
        let request =
            request(&device, b"SYNTHETIC_IDENTIFIER", &[address], 8050, &[7; 16]).unwrap();
        let decoded = p::decode(&request).unwrap();
        assert_eq!(p::data(&decoded, 3).unwrap(), b"SYNTHETIC_IDENTIFIER");
        for rejected in [
            Ipv4Addr::LOCALHOST,
            Ipv4Addr::new(198, 18, 0, 1),
            Ipv4Addr::new(100, 64, 0, 1),
            Ipv4Addr::new(8, 8, 8, 8),
        ] {
            assert!(super::request(&device, b"id", &[rejected], 8050, &[7; 16]).is_err());
        }
        assert!(super::request(&device, b"id", &[address], 0, &[7; 16]).is_err());
        let base = p::message(&[p::uint(1, 0)]).unwrap();
        let response = p::message(&[p::bytes(1, &base), p::bytes(2, b"SYNTHETIC_TOKEN")]).unwrap();
        assert_eq!(token(&response).unwrap().as_slice(), b"SYNTHETIC_TOKEN");
        assert!(token(&vec![0; 16385]).is_err());
    }
}
