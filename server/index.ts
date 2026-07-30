import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { storage } from "./storage";
import { startPhoneAccessServer } from "./phone-mcp-server";
import { formatHttpUrl, listenWithPortFallback, parseTcpPort } from "./port-fallback";
import { createLanAccessGuard, loadLanAccessConfig } from "./lan-access";

const app = express();
const lanAccessConfig = loadLanAccessConfig();
if (lanAccessConfig) app.use(createLanAccessGuard(lanAccessConfig));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  if (process.env.PHONE_ACCESS_ENABLED?.toLowerCase() === "true") {
    await startPhoneAccessServer(storage);
  }

  // Keep unknown API requests from falling through to the client application.
  // A missing upload route must return an error, never the HTML app shell.
  app.use("/api", (_req, res) => {
    res.status(404).json({ message: "API route not found" });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Prefer the familiar port, but keep the app usable when another local
  // service already owns it. Port 5002 remains reserved for the phone MCP.
  const preferredPort = parseTcpPort(process.env.PORT, 5000, "PORT");
  const phonePort = parseTcpPort(process.env.PHONE_ACCESS_PORT, 5002, "PHONE_ACCESS_PORT");
  const host = process.env.HOST || "127.0.0.1";
  const port = await listenWithPortFallback(server, {
    host,
    preferredPort,
    maxAttempts: 20,
    reservedPorts: new Set([phonePort]),
    onPortUnavailable: (unavailablePort, nextPort) => {
      log(
        nextPort === null
          ? `port ${unavailablePort} is already in use`
          : `port ${unavailablePort} is already in use; trying ${nextPort}`,
      );
    },
  });
  log(`serving on ${formatHttpUrl(host, port)}`);
})().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
