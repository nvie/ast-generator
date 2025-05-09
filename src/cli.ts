#!/usr/bin/env node
import { Command } from "commander"

import { generateAST } from "./generator.js"

function red(msg: string) {
  if (typeof process !== "undefined" && process.stdout.isTTY) {
    return "\u001b[31m" + msg + "\u001b[39m"
  } else {
    return msg
  }
}

async function main() {
  const cmd = new Command("generate-ast")
    .description("Generate a TypeScript module for the AST defined in the grammar")
    .argument("<infile>", "Source grammar (*.grammar)")
    .parse(process.argv)

  const infile = cmd.args[0]
  if (!infile) {
    cmd.help()
    process.exit(2)
  }

  // Run compiler
  await generateAST(infile)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(red((e as Error).message))
    process.exit(1)
  })
