//! HTTP abstraction so the referee logic can run against a mock in `cargo test`.
//! The real implementation (`WasiHttp`) is only compiled for `target_os = "wasi"`.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpError {
    /// Connection / transport failure.
    Send,
    /// Connect or read timeout.
    Timeout,
}

pub trait Http {
    fn post(&mut self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<HttpResponse, HttpError>;
    fn get(&mut self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, HttpError>;
    /// Back-off between signature polls. Mocks make this a no-op.
    fn sleep_ms(&mut self, ms: u64);
}

#[cfg(target_os = "wasi")]
pub struct WasiHttp;

#[cfg(target_os = "wasi")]
impl WasiHttp {
    fn map_err(e: &dyn std::fmt::Display) -> HttpError {
        let s = e.to_string().to_ascii_lowercase();
        if s.contains("timeout") || s.contains("timed out") {
            HttpError::Timeout
        } else {
            HttpError::Send
        }
    }

    fn finish<E: std::fmt::Display>(r: Result<wasi_http_client::Response, E>) -> Result<HttpResponse, HttpError> {
        let r = r.map_err(|e| Self::map_err(&e))?;
        let status = r.status();
        let body = r.body().map_err(|e| Self::map_err(&e))?;
        Ok(HttpResponse { status, body })
    }
}

#[cfg(target_os = "wasi")]
impl Http for WasiHttp {
    fn post(&mut self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<HttpResponse, HttpError> {
        let mut rb = wasi_http_client::Client::new().post(url);
        for (k, v) in headers {
            rb = rb.header(*k, *v);
        }
        Self::finish(rb.connect_timeout(std::time::Duration::from_secs(30)).body(body).send())
    }

    fn get(&mut self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, HttpError> {
        let mut rb = wasi_http_client::Client::new().get(url);
        for (k, v) in headers {
            rb = rb.header(*k, *v);
        }
        Self::finish(rb.connect_timeout(std::time::Duration::from_secs(15)).send())
    }

    fn sleep_ms(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

/// Native stand-in so the binary still builds off-WASI; every request fails.
#[cfg(not(target_os = "wasi"))]
pub struct NoHttp;

#[cfg(not(target_os = "wasi"))]
impl Http for NoHttp {
    fn post(&mut self, _: &str, _: &[(&str, &str)], _: &[u8]) -> Result<HttpResponse, HttpError> {
        Err(HttpError::Send)
    }
    fn get(&mut self, _: &str, _: &[(&str, &str)]) -> Result<HttpResponse, HttpError> {
        Err(HttpError::Send)
    }
    fn sleep_ms(&mut self, _: u64) {}
}
