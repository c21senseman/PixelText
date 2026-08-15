import type { Plugin } from "vite";

const RELEASE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function sourceText(source: string | Uint8Array): string {
  return typeof source === "string" ? source : new TextDecoder().decode(source);
}

function outputFileName(reference: string): string {
  return reference
    .split(/[?#]/u, 1)[0]
    .replace(/^\.\//u, "")
    .replace(/^\//u, "");
}

function safeScript(code: string): string {
  return code.replace(/<\/script/giu, "<\\/script");
}

function safeStyle(css: string): string {
  return css.replace(/<\/style/giu, "<\\/style");
}

/**
 * Inlines Vite's JavaScript and CSS outputs into index.html, then removes every
 * other emitted file. The build fails if any asset cannot be represented by
 * the standalone HTML document.
 */
export function singleHtml(): Plugin {
  return {
    name: "pixeltext-single-html",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlAssets = Object.values(bundle).filter(
        (item) => item.type === "asset" && item.fileName.endsWith(".html"),
      );
      const chunks = Object.values(bundle).filter(
        (item) => item.type === "chunk",
      );

      if (htmlAssets.length !== 1 || chunks.length !== 1) {
        this.error(
          `단일 HTML 빌드는 HTML 1개와 JavaScript 청크 1개가 필요합니다. ` +
            `(HTML ${htmlAssets.length}개, JavaScript ${chunks.length}개)`,
        );
      }

      const htmlAsset = htmlAssets[0];
      const chunk = chunks[0];
      if (htmlAsset.type !== "asset" || chunk.type !== "chunk") {
        this.error("단일 HTML 산출물의 형식을 확인할 수 없습니다.");
      }
      const inlinedFiles = new Set<string>();
      let html = sourceText(htmlAsset.source);

      html = html.replace(
        /<script\b([^>]*?)\bsrc=(['"])([^'"]+)\2([^>]*)><\/script>/giu,
        (tag, before: string, _quote: string, reference: string, after: string) => {
          if (outputFileName(reference) !== chunk.fileName) return tag;
          inlinedFiles.add(chunk.fileName);
          const attributes = `${before}${after}`.replace(
            /\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/giu,
            "",
          );
          return `<script${attributes}>${safeScript(chunk.code)}</script>`;
        },
      );

      for (const item of Object.values(bundle)) {
        if (
          item.type !== "asset" ||
          item.fileName === htmlAsset.fileName ||
          !item.fileName.endsWith(".css")
        ) {
          continue;
        }
        const css = sourceText(item.source);
        html = html.replace(
          /<link\b([^>]*?)\bhref=(['"])([^'"]+)\2([^>]*)>/giu,
          (tag, before: string, _quote: string, reference: string, after: string) => {
            if (outputFileName(reference) !== item.fileName) return tag;
            if (!/\brel=(['"])stylesheet\1/iu.test(`${before}${after}`)) {
              return tag;
            }
            inlinedFiles.add(item.fileName);
            return `<style>${safeStyle(css)}</style>`;
          },
        );
      }

      if (!/<\/head>/iu.test(html)) {
        this.error("단일 HTML에 head 닫기 태그가 없습니다.");
      }
      html = html.replace(
        /<\/head>/iu,
        `<meta http-equiv="Content-Security-Policy" content="${RELEASE_CSP}" />\n</head>`,
      );

      const externalOutputs = Object.values(bundle).filter(
        (item) =>
          item.fileName !== htmlAsset.fileName &&
          !inlinedFiles.has(item.fileName),
      );
      if (externalOutputs.length > 0) {
        this.error(
          `단일 HTML에 포함되지 않은 산출물이 있습니다: ${externalOutputs
            .map((item) => item.fileName)
            .join(", ")}`,
        );
      }

      htmlAsset.source = html;
      for (const fileName of inlinedFiles) delete bundle[fileName];
    },
  };
}
