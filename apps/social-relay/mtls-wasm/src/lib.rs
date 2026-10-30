//! A TLS client that presents a client certificate, driven over bytes the JS side moves to
//! and from a `cloudflare:sockets` connection (`apps/social-relay/src/mtls-client.ts`).
//! rustls does the TLS; nothing here is cryptography. See docs/rfc/mtls-hop.md.
use std::io::{Cursor, Read, Write};
use std::sync::Arc;

use rustls::{ClientConfig, ClientConnection, RootCertStore};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use wasm_bindgen::prelude::*;

fn err(stage: &str, e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{stage}: {e}"))
}

#[wasm_bindgen]
pub struct MtlsClient {
    conn: ClientConnection,
}

#[wasm_bindgen]
impl MtlsClient {
    /// `root_pem`: the ONLY roots trusted (BankID's own). `cert_pem` may hold a chain.
    #[wasm_bindgen(constructor)]
    pub fn new(hostname: &str, root_pem: &str, cert_pem: &str, key_pem: &str) -> Result<MtlsClient, JsValue> {
        let mut roots = RootCertStore::empty();
        for c in CertificateDer::pem_slice_iter(root_pem.as_bytes()) {
            roots.add(c.map_err(|e| err("root pem", e))?).map_err(|e| err("root cert", e))?;
        }
        if roots.is_empty() {
            return Err(err("root pem", "no certificate found"));
        }
        let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
            .collect::<Result<_, _>>()
            .map_err(|e| err("client cert pem", e))?;
        if chain.is_empty() {
            return Err(err("client cert pem", "no certificate found"));
        }
        // Never the parser's own message: a PEM error can quote the line it stopped at, and this
        // one is a private key.
        let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())
            .map_err(|_| err("client key pem", "not a PEM private key (PKCS#8, PKCS#1 or SEC1)"))?;
        let config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_client_auth_cert(chain, key)
            .map_err(|e| err("client auth", e))?;
        let name = ServerName::try_from(hostname.to_owned()).map_err(|e| err("server name", e))?;
        let conn = ClientConnection::new(Arc::new(config), name).map_err(|e| err("tls init", e))?;
        Ok(MtlsClient { conn })
    }

    /// Bytes read off the socket. Returns the plaintext they completed, if any.
    pub fn receive(&mut self, data: &[u8]) -> Result<Vec<u8>, JsValue> {
        let mut cur = Cursor::new(data);
        let mut out = Vec::new();
        // Never `read_tls` an exhausted chunk: rustls reads its `Ok(0)` as the socket's end.
        while (cur.position() as usize) < data.len() {
            // Nothing taken from a chunk that is not used up: the peer's close_notify ended the
            // stream, and rustls takes no more input, whatever follows it.
            if self.conn.read_tls(&mut cur).map_err(|e| err("read_tls", e))? == 0 {
                break;
            }
            self.conn.process_new_packets().map_err(|e| err("tls", e))?;
            // Drained after every pass: rustls buffers at most 16 KiB of plaintext, and one socket
            // chunk can complete more than that.
            match self.conn.reader().read_to_end(&mut out) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(err("read plaintext", e)),
            }
        }
        Ok(out)
    }

    /// Bytes to write to the socket now.
    pub fn transmit(&mut self) -> Result<Vec<u8>, JsValue> {
        let mut out = Vec::new();
        while self.conn.wants_write() {
            self.conn.write_tls(&mut out).map_err(|e| err("write_tls", e))?;
        }
        Ok(out)
    }

    pub fn send(&mut self, plaintext: &[u8]) -> Result<(), JsValue> {
        self.conn.writer().write_all(plaintext).map_err(|e| err("write plaintext", e))
    }

    pub fn close(&mut self) {
        self.conn.send_close_notify();
    }

    #[wasm_bindgen(getter)]
    pub fn handshaking(&self) -> bool {
        self.conn.is_handshaking()
    }

    #[wasm_bindgen(getter)]
    pub fn protocol(&self) -> Option<String> {
        self.conn.protocol_version().map(|v| format!("{v:?}"))
    }
}

/// `receive` against an in-memory rustls server, run by tools/mtls-wasm-emit.mjs in the same image.
#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
    use rustls::{ServerConfig, ServerConnection};

    /// A client and a server that have finished their handshake, the server holding `host`'s certificate.
    fn connected() -> (MtlsClient, ServerConnection) {
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let leaf_key = KeyPair::generate().unwrap();
        let leaf = CertificateParams::new(vec!["bankid.test".to_owned()]).unwrap().signed_by(&leaf_key, &ca, &ca_key).unwrap();

        let mut client = MtlsClient::new("bankid.test", &ca.pem(), &leaf.pem(), &leaf_key.serialize_pem()).unwrap();
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![leaf.der().clone()], PrivateKeyDer::try_from(leaf_key.serialize_der()).unwrap())
            .unwrap();
        let mut server = ServerConnection::new(Arc::new(config)).unwrap();
        while client.handshaking() || server.is_handshaking() {
            server.read_tls(&mut Cursor::new(client.transmit().unwrap())).unwrap();
            server.process_new_packets().unwrap();
            let mut back = Vec::new();
            while server.wants_write() {
                server.write_tls(&mut back).unwrap();
            }
            client.receive(&back).unwrap();
        }
        (client, server)
    }

    fn records(server: &mut ServerConnection) -> Vec<u8> {
        let mut out = Vec::new();
        while server.wants_write() {
            server.write_tls(&mut out).unwrap();
        }
        out
    }

    #[test]
    fn returns_when_close_notify_is_followed_by_more_bytes() {
        let (mut client, mut server) = connected();
        server.writer().write_all(b"answer").unwrap();
        server.send_close_notify();
        // More than one `read_tls` takes, so bytes are still left once the close_notify is in.
        let mut chunk = records(&mut server);
        chunk.extend(vec![0x17; 20 * 1024]);
        assert_eq!(client.receive(&chunk).unwrap(), b"answer");
    }

    #[test]
    fn accepts_more_than_16_kib_of_plaintext_in_one_chunk() {
        let (mut client, mut server) = connected();
        let body = vec![b'x'; 40 * 1024];
        server.writer().write_all(&body).unwrap();
        assert_eq!(client.receive(&records(&mut server)).unwrap(), body);
    }
}
