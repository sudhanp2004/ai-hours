import http.server, ssl, time, json, sys
PAGE = b"""<!doctype html><html><head><meta charset=utf-8><title>fake chatgpt</title></head><body>
<script>
// Like the real site: the stop button is inserted while a reply streams and removed after.
async function ask() {
  const b = document.createElement('button');
  b.setAttribute('data-testid', 'stop-button');
  b.textContent = 'stop';
  document.body.appendChild(b);
  const r = await fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ conversation_id: null, messages: [{ id: 'u1', author: { role: 'user' } }] }) });
  await r.text();
  b.remove();
  document.title = 'done';
}
setTimeout(ask, 1500);
</script></body></html>"""
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header('content-type','text/html'); self.end_headers(); self.wfile.write(PAGE)
    def do_POST(self):
        n = int(self.headers.get('content-length') or 0); self.rfile.read(n)
        if self.path.endswith('/f/conversation'):
            self.send_response(200); self.send_header('content-type','text/event-stream'); self.end_headers()
            msg = {"v": {"message": {"id": "a1", "author": {"role": "assistant"}, "status": "in_progress", "content": {"content_type": "text", "parts": ["hi"]}, "metadata": {"turn_exchange_id": "t1", "model_slug": "gpt-5"}}}}
            for i in range(6):
                self.wfile.write(b'data: ' + json.dumps(msg).encode() + b'\n\n'); self.wfile.flush(); time.sleep(0.5)
            self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
        else:
            self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(b'{}')
s = http.server.ThreadingHTTPServer(('127.0.0.1', 8443), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain('cert.pem', 'key.pem')
s.socket = ctx.wrap_socket(s.socket, server_side=True)
s.serve_forever()
