import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function validateBaseUrl(urlStr: string, allowHttp = false): string {
  if (!urlStr) {
    throw new Error("Base URL is required");
  }

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error("Invalid URL format");
  }

  const allowedProtocols = allowHttp ? ["http:", "https:"] : ["https:"];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(
      allowHttp
        ? "Base URL must use HTTP or HTTPS protocol"
        : "Base URL must use HTTPS protocol"
    );
  }

  if (url.username || url.password) {
    throw new Error("Base URL must not contain credentials");
  }

  if (url.search) {
    throw new Error("Base URL must not contain query parameters");
  }

  if (url.hash) {
    throw new Error("Base URL must not contain fragments");
  }

  // Remove trailing slashes
  return urlStr.replace(/\/+$/, "");
}

export function generateSlackManifest(baseUrl: string, allowHttp = false): string {
  const cleanUrl = validateBaseUrl(baseUrl, allowHttp);
  const templatePath = path.resolve(__dirname, "../../manifests/slack-app.yaml.template");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Slack template not found at ${templatePath}`);
  }
  const content = fs.readFileSync(templatePath, "utf8");
  return content.replace(/__PUBLIC_BASE_URL__/g, cleanUrl);
}

export function generateGitHubManifest(baseUrl: string, allowHttp = false): Record<string, unknown> {
  const cleanUrl = validateBaseUrl(baseUrl, allowHttp);
  const templatePath = path.resolve(__dirname, "../../manifests/github-app.json.template");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`GitHub template not found at ${templatePath}`);
  }
  const content = fs.readFileSync(templatePath, "utf8");
  const replaced = content.replace(/__PUBLIC_BASE_URL__/g, cleanUrl);
  return JSON.parse(replaced) as Record<string, unknown>;
}
