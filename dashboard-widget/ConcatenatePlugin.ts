import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Compiler } from "@rspack/core";

interface ConcatenatePluginOptions {
  source?: string;
  destination: string;
  name: string;
  ignore?: string[];
  /** Hashed for the build id. Extend if the widget compiles anything outside `src/`. */
  inputs?: string[];
}

/**
 * Deterministic build id from src/ + package.json. Scopes this build's webpack
 * and module-federation globals so two builds of one widget in the same page
 * stay independent — otherwise the second to load adopts the first's module
 * registry and renders its code.
 */
function buildId(inputs: string[]): string {
  const hash = createHash("sha256");
  const walk = (target: string) => {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return; // optional input, e.g. no lockfile committed
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) {
        walk(path.join(target, entry));
      }
      return;
    }
    hash.update(target);
    hash.update(fs.readFileSync(target));
  };
  inputs.forEach(walk);
  return hash.digest("hex").slice(0, 8);
}

/**
 * Doover expects a widget at one asset path. Module Federation emits several
 * JavaScript files, so concatenate those files deterministically after build.
 */
class ConcatenatePlugin {
  private readonly source: string;
  private readonly destination: string;
  private readonly name: string;
  private readonly ignore: string[];
  private readonly widgetName: string;
  private readonly buildId: string;

  constructor(options: ConcatenatePluginOptions) {
    this.source = options.source ?? "./dist";
    this.destination = path.resolve(options.destination);
    this.name = options.name;
    this.ignore = options.ignore ?? [];
    this.widgetName = path.basename(options.name, path.extname(options.name));
    this.buildId = buildId(
      options.inputs ?? ["src", "package.json", "package-lock.json"],
    );
    // The module-federation plugin reads this when it applies, which is after
    // the config — and so this constructor — has been evaluated.
    process.env.MF_BUILD_VERSION ??= this.buildId;
  }

  apply(compiler: Compiler): void {
    // The container global (the module federation `name`) stays fixed; the host
    // looks the widget up by it.
    compiler.options.output.uniqueName = `${this.widgetName}_${this.buildId}`;
    compiler.options.output.chunkLoadingGlobal = `chunk_${this.widgetName}_${this.buildId}`;

    compiler.hooks.afterEmit.tapAsync(
      "ConcatenatePlugin",
      (_compilation, callback) => {
        try {
          const files = this.findJavaScriptFiles(path.resolve(this.source));
          if (files.length === 0) {
            callback(new Error("Rsbuild produced no JavaScript files"));
            return;
          }

          const contents = files
            .map((file) => fs.readFileSync(file, "utf8"))
            .join("\n");

          fs.mkdirSync(this.destination, { recursive: true });
          fs.writeFileSync(path.join(this.destination, this.name), contents);
          console.log(
            `[ConcatenatePlugin] Built ${this.name} from ${files.length} chunks`,
          );
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    );
  }

  private findJavaScriptFiles(directory: string): string[] {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory()
          ? this.findJavaScriptFiles(entryPath)
          : path.extname(entry.name) === ".js" &&
              !this.ignore.includes(entry.name)
            ? [entryPath]
            : [];
      })
      .sort();
  }
}

export default ConcatenatePlugin;
