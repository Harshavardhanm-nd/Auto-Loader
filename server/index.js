import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { authRouter } from './routes/auth.js';
import { catalogRouter } from './routes/catalog.js';
import { runsRouter } from './routes/runs.js';
import { ensureDirs, ROOT } from './lib/paths.js';
import { loadEnvironments, loadTemplates } from './lib/config.js';

ensureDirs();

const app = express();
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  next();
});

app.get('/api/health', (req, res) => {
  const templates = loadTemplates();
  res.json({
    ok: true,
    environments: Object.keys(loadEnvironments().environments),
    templates: templates.map((t) => ({ id: t.id, status: t.status })),
    awaitingTemplates: templates.filter((t) => t.status !== 'verified').map((t) => t.id),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/runs', runsRouter);

// Serve the built UI in production; in dev, Vite serves it and proxies /api here.
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, next) => {
  const status = err.status ?? 400;
  console.error(`${req.method} ${req.path} → ${status}: ${err.message}`);
  res.status(status).json({
    error: err.message,
    name: err.name,
    // Session expiry is the one error the UI must react to structurally rather than just
    // display, so it is flagged explicitly.
    needsReconnect: err.name === 'SalesforceSessionExpiredError' || err.name === 'SalesforceNotConnectedError',
    env: err.env ?? null,
  });
});

const port = Number(process.env.PORT) || 4317;
app.listen(port, () => {
  console.log(`Auto_Loader server on http://localhost:${port}`);
  const awaiting = loadTemplates().filter((t) => t.status !== 'verified');
  if (awaiting.length) {
    console.log(
      `  templates awaiting a real format: ${awaiting.map((t) => t.id).join(', ')} ` +
        '(those lines cannot be generated or sent yet)'
    );
  }
});
