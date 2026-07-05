import { parseArgs } from "util";
import fs from "fs";
import path from "path";
import { generateSlackManifest, generateGitHubManifest } from "../src/services/manifest-service.js";

function main() {
  const { values } = parseArgs({
    options: {
      "base-url": {
        type: "string",
      },
      "output-dir": {
        type: "string",
        default: "./generated-manifests",
      },
      "allow-http": {
        type: "boolean",
        default: false,
      },
    },
  });

  const baseUrl = values["base-url"];
  const outputDir = values["output-dir"] as string;
  const allowHttp = values["allow-http"] as boolean;

  if (!baseUrl) {
    console.error("Error: --base-url is required.");
    console.error("Usage: npm run generate:manifests -- --base-url <url> [--output-dir <dir>] [--allow-http]");
    process.exit(1);
  }

  try {
    const resolvedOutputDir = path.resolve(outputDir);
    if (!fs.existsSync(resolvedOutputDir)) {
      fs.mkdirSync(resolvedOutputDir, { recursive: true });
    }

    const slackManifest = generateSlackManifest(baseUrl, allowHttp);
    const githubManifest = generateGitHubManifest(baseUrl, allowHttp);

    fs.writeFileSync(path.join(resolvedOutputDir, "slack-app.yaml"), slackManifest, "utf8");
    fs.writeFileSync(path.join(resolvedOutputDir, "github-app.json"), JSON.stringify(githubManifest, null, 2), "utf8");

    console.log(`Successfully generated manifests in ${resolvedOutputDir}`);
    console.log(`- slack-app.yaml`);
    console.log(`- github-app.json`);
  } catch (err: any) {
    console.error(`Error generating manifests: ${err.message}`);
    process.exit(1);
  }
}

main();
