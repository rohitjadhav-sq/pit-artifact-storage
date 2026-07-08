import type { FastifyInstance } from 'fastify';

// Minimal same-origin demo page for exercising the SSE stream and uploads by hand.
// Served by the API itself so no CORS setup is needed to try it out. The script is a
// separate route (not inline) to stay compatible with the helmet CSP defaults.

const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Pit Artifact Storage SSE demo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    input, button { font: inherit; padding: 0.3rem 0.6rem; }
    pre { background: #f4f4f4; padding: 1rem; min-height: 12rem; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>Pit Artifact Storage SSE demo</h1>
  <p>
    Connect to a system's event stream, then upload a file to the same system
    (from here or via <code>curl</code>) and watch the <code>artifact.created</code> event arrive.
  </p>
  <p>
    <label>System ID <input id="system" value="sys_alpha" /></label>
    <button id="connect">Connect</button>
  </p>
  <p>
    <input type="file" id="file" />
    <button id="upload">Upload</button>
  </p>
  <pre id="log"></pre>
  <script src="/demo.js"></script>
</body>
</html>
`;

const DEMO_JS = `'use strict';
var es = null;

function log(message) {
  var line = '[' + new Date().toLocaleTimeString() + '] ' + message + '\\n';
  document.getElementById('log').textContent += line;
}

document.getElementById('connect').addEventListener('click', function () {
  var systemId = document.getElementById('system').value;
  if (es) es.close();
  es = new EventSource('/api/v1/systems/' + encodeURIComponent(systemId) + '/events');
  log('connecting to "' + systemId + '"...');
  es.onopen = function () { log('connected'); };
  es.onerror = function () { log('connection error (browser retries automatically)'); };
  es.addEventListener('artifact.created', function (event) {
    var artifact = JSON.parse(event.data);
    log('artifact.created: ' + artifact.name + ' v' + artifact.version +
        ' -> ' + artifact.links.content);
  });
});

document.getElementById('upload').addEventListener('click', function () {
  var input = document.getElementById('file');
  if (!input.files.length) { log('choose a file first'); return; }
  var systemId = document.getElementById('system').value;
  var form = new FormData();
  form.append('file', input.files[0]);
  fetch('/api/v1/systems/' + encodeURIComponent(systemId) + '/artifacts', {
    method: 'POST',
    body: form,
  }).then(function (res) {
    log('upload: HTTP ' + res.status);
  }).catch(function (err) {
    log('upload failed: ' + err);
  });
});
`;

export function registerDemoRoutes(app: FastifyInstance): void {
  app.get('/demo', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(DEMO_HTML),
  );
  app.get('/demo.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(DEMO_JS),
  );
}
