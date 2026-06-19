#!/usr/bin/env node
import { Command } from "commander";
import { api, apiBaseUrl } from "./api.js";

const program = new Command();

program.name("archer").description("Archer CLI").version("0.1.0");

program
  .command("hello")
  .description("Print a friendly greeting")
  .argument("[name]", "name to greet", "world")
  .action((name: string) => {
    console.log(`Hello, ${name}!`);
  });

program
  .command("health")
  .description("Check the API health via typed RPC")
  .action(async () => {
    try {
      const res = await api.health.$get();
      const data = await res.json();
      console.log(`API status: ${data.status}`);
    } catch {
      console.error(`Failed to reach API at ${apiBaseUrl}`);
      process.exitCode = 1;
    }
  });

program.parse();
