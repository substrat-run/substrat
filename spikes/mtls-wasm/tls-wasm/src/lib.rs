//! A TLS client that presents a client certificate, driven over bytes the JS side moves to
//! and from a `cloudflare:sockets` connection. rustls does the TLS; nothing here is crypto.
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
        let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).map_err(|e| err("client key pem", e))?;
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
        while (cur.position() as usize) < data.len() {
            self.conn.read_tls(&mut cur).map_err(|e| err("read_tls", e))?;
            self.conn.process_new_packets().map_err(|e| err("tls", e))?;
        }
        let mut out = Vec::new();
        match self.conn.reader().read_to_end(&mut out) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(err("read plaintext", e)),
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
