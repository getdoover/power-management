// ConcatenatePlugin.ts
import * as fs from 'fs';
import * as path from 'path';
import {Compiler, Compilation} from 'webpack';

interface ConcatenatePluginOptions {
    source?: string;
    destination: string;
    name: string;
    ignore?: string[];
}

class ConcatenatePlugin {
    readonly source: string;
    readonly destination: string;
    readonly name: string;
    readonly ignore: string[];

    constructor(options: ConcatenatePluginOptions) {
        this.source = options.source || './dist';
        this.destination = path.resolve(options.destination);
        this.name = options.name;
        this.ignore = options.ignore || [];
    }

    apply(compiler: Compiler): void {
        // Hook into afterEmit to concatenate files after build
        compiler.hooks.afterEmit.tapAsync('ConcatenatePlugin', (compilation: Compilation, callback: (error?: Error | null) => void) => {
            try {
                const sourceDir = path.resolve(this.source);

                // Find all JS files in the dist directory (including subdirectories)
                const jsFiles = this.findJsFiles(sourceDir, this.ignore);

                if (jsFiles.length === 0) {
                    console.warn('[ConcatenatePlugin] No JS files found to concatenate');
                    callback();
                    return;
                }

                // Read and concatenate all files
                const contents = jsFiles.map((file) => {
                    const content = fs.readFileSync(file, 'utf8');
                    console.log(`[ConcatenatePlugin] Adding ${path.relative(sourceDir, file)}`);
                    return content;
                }).join('\n');

                // Ensure destination directory exists
                if (!fs.existsSync(this.destination)) {
                    fs.mkdirSync(this.destination, {recursive: true});
                }

                // Write concatenated output
                const outputPath = path.join(this.destination, this.name);
                fs.writeFileSync(outputPath, contents);

                console.log(`[ConcatenatePlugin] Created ${outputPath} (${(contents.length / 1024).toFixed(2)} KB)`);

                callback();
            } catch (error) {
                console.error('[ConcatenatePlugin] Error:', error);
                callback(error as Error);
            }
        });
    }

    private findJsFiles(dir: string, ignore: string[] = []): string[] {
        let results: string[] = [];
        const files = fs.readdirSync(dir);

        files.forEach((file) => {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
                // Recursively search subdirectories
                results = results.concat(this.findJsFiles(filePath, ignore));
            } else if (path.extname(file) === '.js' && !ignore.includes(file)) {
                results.push(filePath);
            }
        });

        // Sort to ensure consistent order
        return results.sort();
    }
}

export default ConcatenatePlugin;