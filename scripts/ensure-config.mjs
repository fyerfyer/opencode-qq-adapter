import { copyFileSync, existsSync, mkdirSync } from "node:fs";

if (!existsSync("config/config.yaml")) {
  mkdirSync("config", { recursive: true });
  copyFileSync("config/config.example.yaml", "config/config.yaml");
  console.log("Created config/config.yaml from config/config.example.yaml");
}
if (!existsSync(".env")) {
  console.log("Hint: copy .env.example to .env and set NAPCAT_ACCESS_TOKEN before logging in to NapCat.");
}
