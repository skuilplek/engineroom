export type SyntaxTokenKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "type"
  | "operator"
  | "property"
  | "punctuation"
  | "plain";

export interface SyntaxToken {
  kind: SyntaxTokenKind;
  text: string;
}

export type SyntaxLanguage =
  | "ts"
  | "js"
  | "py"
  | "rs"
  | "go"
  | "sh"
  | "json"
  | "css"
  | "html"
  | "md"
  | "yaml"
  | "toml"
  | "sql"
  | "c"
  | "plain";

const KEYWORDS: Record<SyntaxLanguage, Set<string>> = {
  ts: new Set([
    "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
    "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends",
    "false", "finally", "for", "from", "function", "get", "if", "implements", "import", "in",
    "instanceof", "interface", "is", "keyof", "let", "module", "namespace", "new", "null",
    "of", "override", "package", "private", "protected", "public", "readonly", "return", "satisfies",
    "set", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
    "undefined", "var", "void", "while", "with", "yield",
  ]),
  js: new Set([
    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
    "default", "delete", "do", "else", "export", "extends", "false", "finally", "for", "from",
    "function", "get", "if", "import", "in", "instanceof", "let", "new", "null", "of",
    "return", "set", "static", "super", "switch", "this", "throw", "true", "try", "typeof",
    "undefined", "var", "void", "while", "with", "yield",
  ]),
  py: new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
    "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
    "if", "import", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise",
    "return", "self", "try", "while", "with", "yield",
  ]),
  rs: new Set([
    "Self", "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
    "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match",
    "mod", "move", "mut", "pub", "ref", "return", "self", "static", "struct", "super",
    "trait", "true", "type", "unsafe", "use", "where", "while",
  ]),
  go: new Set([
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
    "false", "for", "func", "go", "goto", "if", "import", "interface", "map", "nil", "package",
    "range", "return", "select", "struct", "switch", "true", "type", "var",
  ]),
  sh: new Set([
    "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if",
    "in", "local", "readonly", "return", "select", "set", "shift", "source", "then", "trap",
    "unset", "until", "while",
  ]),
  json: new Set(["true", "false", "null"]),
  css: new Set([
    "important", "from", "to", "media", "keyframes", "supports", "import", "layer", "var",
    "calc", "rgb", "rgba", "hsl", "hsla", "linear-gradient", "radial-gradient",
  ]),
  html: new Set(["doctype", "html", "head", "body", "script", "style", "div", "span", "section", "header", "footer", "main", "aside", "nav", "form", "button", "input", "label", "select", "option", "textarea", "p", "h1", "h2", "h3", "ul", "ol", "li", "a", "img", "svg", "path"]),
  md: new Set([]),
  yaml: new Set(["true", "false", "null", "yes", "no", "on", "off"]),
  toml: new Set(["true", "false"]),
  sql: new Set([
    "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
    "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW", "JOIN", "INNER", "LEFT", "RIGHT",
    "OUTER", "ON", "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "EXISTS", "BETWEEN", "LIKE",
    "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "UNION", "ALL", "DISTINCT", "PRIMARY",
    "KEY", "FOREIGN", "REFERENCES", "DEFAULT", "BEGIN", "COMMIT", "ROLLBACK",
    "select", "from", "where", "insert", "into", "values", "update", "set", "delete",
    "create", "table", "alter", "drop", "index", "view", "join", "inner", "left", "right",
    "outer", "on", "as", "and", "or", "not", "null", "is", "in", "exists", "between", "like",
    "order", "by", "group", "having", "limit", "offset", "union", "all", "distinct", "primary",
    "key", "foreign", "references", "default", "begin", "commit", "rollback",
  ]),
  c: new Set([
    "auto", "bool", "break", "case", "catch", "char", "class", "const", "constexpr", "continue",
    "default", "delete", "do", "double", "else", "enum", "explicit", "extern", "false", "float",
    "for", "friend", "goto", "if", "inline", "int", "long", "namespace", "new", "noexcept",
    "nullptr", "operator", "private", "protected", "public", "register", "return", "short",
    "signed", "sizeof", "static", "struct", "switch", "template", "this", "throw", "true",
    "try", "typedef", "typename", "union", "unsigned", "using", "virtual", "void", "volatile",
    "while",
  ]),
  plain: new Set([]),
};

const BUILTIN_TYPES = new Set([
  "string", "number", "boolean", "any", "unknown", "never", "object", "symbol", "bigint",
  "Promise", "Array", "Record", "Map", "Set", "Partial", "Required", "Readonly", "Buffer",
  "Error", "RegExp", "Date", "URL", "HTMLElement", "HTMLDivElement", "HTMLInputElement",
  "String", "Vec", "Option", "Result", "Box", "Arc", "Rc", "HashMap", "HashSet",
  "i8", "i16", "i32", "i64", "isize", "u8", "u16", "u32", "u64", "usize", "f32", "f64", "str",
  "int", "int32", "int64", "uint", "uint32", "uint64", "float32", "float64", "byte", "rune", "error",
]);

export function detectSyntaxLanguage(filePath: string): SyntaxLanguage {
  const base = (filePath.split("/").pop() || filePath).toLowerCase();
  if (base === "dockerfile" || base === "makefile" || base.startsWith(".env") || base.endsWith("rc")) {
    return "sh";
  }
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "ts";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "py":
      return "py";
    case "rs":
      return "rs";
    case "go":
      return "go";
    case "sh":
    case "bash":
    case "zsh":
    case "env":
      return "sh";
    case "json":
    case "jsonc":
    case "jsonl":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
      return "html";
    case "md":
    case "mdx":
    case "markdown":
      return "md";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
    case "ini":
    case "conf":
    case "service":
    case "socket":
      return "toml";
    case "sql":
      return "sql";
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "java":
    case "cs":
      return "c";
    default:
      return "plain";
  }
}

export function highlightCodeLines(content: string, language: SyntaxLanguage): SyntaxToken[][] {
  const rawLines = content.split("\n");
  if (language === "plain") {
    return rawLines.map((line) => (line ? [{ kind: "plain", text: line }] : []));
  }
  if (language === "md") {
    return rawLines.map(highlightMarkdownLine);
  }

  const out: SyntaxToken[][] = [];
  let inBlockComment = false;
  const supportsSlashBlockComment =
    language === "ts" || language === "js" || language === "rs" || language === "go" || language === "css" || language === "sql" || language === "c";
  const supportsHashComment =
    language === "py" || language === "sh" || language === "yaml" || language === "toml";
  const supportsSlashLineComment =
    language === "ts" || language === "js" || language === "rs" || language === "go" || language === "c" || language === "json";
  const supportsDashComment = language === "sql";

  for (const line of rawLines) {
    const tokens: SyntaxToken[] = [];
    const push = (kind: SyntaxTokenKind, text: string) => {
      if (!text) return;
      const prev = tokens[tokens.length - 1];
      if (prev && prev.kind === kind) {
        prev.text += text;
      } else {
        tokens.push({ kind, text });
      }
    };

    let i = 0;
    const len = line.length;

    while (i < len) {
      if (inBlockComment) {
        const closeIdx = line.indexOf("*/", i);
        if (closeIdx < 0) {
          push("comment", line.slice(i));
          i = len;
          break;
        }
        push("comment", line.slice(i, closeIdx + 2));
        i = closeIdx + 2;
        inBlockComment = false;
        continue;
      }

      const ch = line[i]!;
      const next = line[i + 1];

      // Whitespace
      if (ch === " " || ch === "\t" || ch === "\r") {
        let j = i + 1;
        while (j < len && (line[j] === " " || line[j] === "\t" || line[j] === "\r")) j += 1;
        push("plain", line.slice(i, j));
        i = j;
        continue;
      }

      // HTML comments
      if (language === "html" && line.startsWith("<!--", i)) {
        const closeIdx = line.indexOf("-->", i + 4);
        if (closeIdx < 0) {
          push("comment", line.slice(i));
          break;
        }
        push("comment", line.slice(i, closeIdx + 3));
        i = closeIdx + 3;
        continue;
      }

      // Block comment start
      if (supportsSlashBlockComment && ch === "/" && next === "*") {
        const closeIdx = line.indexOf("*/", i + 2);
        if (closeIdx < 0) {
          push("comment", line.slice(i));
          inBlockComment = true;
          break;
        }
        push("comment", line.slice(i, closeIdx + 2));
        i = closeIdx + 2;
        continue;
      }

      // Line comments
      if (
        (supportsSlashLineComment && ch === "/" && next === "/") ||
        (supportsHashComment && ch === "#") ||
        (supportsDashComment && ch === "-" && next === "-")
      ) {
        push("comment", line.slice(i));
        break;
      }

      // Strings
      if (ch === '"' || ch === "'" || (ch === "`" && (language === "ts" || language === "js" || language === "go" || language === "sh" || language === "sql"))) {
        const quote = ch;
        let j = i + 1;
        while (j < len) {
          if (line[j] === "\\") {
            j += 2;
            continue;
          }
          if (line[j] === quote) {
            j += 1;
            break;
          }
          j += 1;
        }
        const raw = line.slice(i, j);
        // JSON property key check
        if (language === "json" && quote === '"') {
          let k = j;
          while (k < len && (line[k] === " " || line[k] === "\t")) k += 1;
          if (line[k] === ":") {
            push("property", raw);
            i = j;
            continue;
          }
        }
        push("string", raw);
        i = j;
        continue;
      }

      // Numbers
      if (isDigit(ch) || (ch === "." && next !== undefined && isDigit(next))) {
        let j = i + 1;
        while (j < len && /[0-9a-fA-FxXoObB._eE+-]/.test(line[j]!)) j += 1;
        push("number", line.slice(i, j));
        i = j;
        continue;
      }

      // Decorators / macros / CSS at-rules / shell variables
      if ((ch === "@" || ch === "$") && next !== undefined && isIdentStart(next)) {
        let j = i + 2;
        while (j < len && isIdentPart(line[j]!)) j += 1;
        push(ch === "$" ? "property" : "keyword", line.slice(i, j));
        i = j;
        continue;
      }

      // Identifiers & keywords
      if (isIdentStart(ch)) {
        let j = i + 1;
        while (j < len && (isIdentPart(line[j]!) || (language === "css" && line[j] === "-"))) j += 1;
        const word = line.slice(i, j);
        let after = j;
        while (after < len && (line[after] === " " || line[after] === "\t")) after += 1;
        const nextChar = line[after];

        if ((language === "yaml" || language === "toml") && nextChar === ":") {
          push("property", word);
        } else if (KEYWORDS[language]?.has(word)) {
          push("keyword", word);
        } else if (BUILTIN_TYPES.has(word) || (/^[A-Z][A-Za-z0-9_]*$/.test(word) && language !== "sh")) {
          push("type", word);
        } else if (nextChar === "(") {
          push("function", word);
        } else if (i > 0 && line[i - 1] === ".") {
          push("property", word);
        } else {
          push("plain", word);
        }
        i = j;
        continue;
      }

      // Punctuation vs Operators
      if ("{}[](),.;:".includes(ch)) {
        push("punctuation", ch);
        i += 1;
        continue;
      }

      if ("+-*/%=&|<>!~^?".includes(ch)) {
        let j = i + 1;
        while (j < len && "+-*/%=&|<>!~^?".includes(line[j]!)) j += 1;
        push("operator", line.slice(i, j));
        i = j;
        continue;
      }

      push("plain", ch);
      i += 1;
    }

    out.push(tokens);
  }

  return out;
}

function highlightMarkdownLine(line: string): SyntaxToken[] {
  if (/^\s*#{1,6}\s/.test(line)) {
    return [{ kind: "keyword", text: line }];
  }
  if (/^\s*```/.test(line)) {
    return [{ kind: "comment", text: line }];
  }
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
    const match = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/);
    if (match) {
      return [
        { kind: "operator", text: match[1]! },
        { kind: "plain", text: match[2]! },
      ];
    }
  }
  if (/^\s*>/.test(line)) {
    return [{ kind: "comment", text: line }];
  }
  return line ? [{ kind: "plain", text: line }] : [];
}

function isDigit(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isIdentStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
