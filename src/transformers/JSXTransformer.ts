import {types as tt} from "../../sucrase-babylon/tokenizer/types";
import ImportProcessor from "../ImportProcessor";
import NameManager from "../NameManager";
import TokenProcessor from "../TokenProcessor";
import RootTransformer from "./RootTransformer";
import Transformer from "./Transformer";

export default class JSXTransformer extends Transformer {
  lastLineNumber: number = 1;
  lastIndex: number = 0;
  filenameVarName: string | null = null;

  constructor(
    readonly rootTransformer: RootTransformer,
    readonly tokens: TokenProcessor,
    readonly importProcessor: ImportProcessor,
    readonly nameManager: NameManager,
    readonly filePath: string | null,
  ) {
    super();
  }

  process(): boolean {
    if (this.tokens.matches1(tt.jsxTagStart)) {
      this.processJSXTag();
      return true;
    }
    return false;
  }

  getPrefixCode(): string {
    if (this.filenameVarName) {
      return `const ${this.filenameVarName} = ${JSON.stringify(this.filePath || "")};`;
    } else {
      return "";
    }
  }

  /**
   * Lazily calculate line numbers to avoid unneeded work. We assume this is always called in
   * increasing order by index.
   */
  getLineNumberForIndex(index: number): number {
    const code = this.tokens.code;
    while (this.lastIndex < index && this.lastIndex < code.length) {
      if (code[this.lastIndex] === "\n") {
        this.lastLineNumber++;
      }
      this.lastIndex++;
    }
    return this.lastLineNumber;
  }

  getFilenameVarName(): string {
    if (!this.filenameVarName) {
      this.filenameVarName = this.nameManager.claimFreeName("_jsxFileName");
    }
    return this.filenameVarName;
  }

  processProps(firstTokenStart: number): void {
    const lineNumber = this.getLineNumberForIndex(firstTokenStart);
    const devProps = `__self: this, __source: {fileName: ${this.getFilenameVarName()}, lineNumber: ${lineNumber}}`;
    if (!this.tokens.matches1(tt.jsxName) && !this.tokens.matches1(tt.braceL)) {
      this.tokens.appendCode(`, {${devProps}}`);
      return;
    }
    this.tokens.appendCode(`, {`);
    while (true) {
      if (this.tokens.matches2(tt.jsxName, tt.eq)) {
        if (this.tokens.currentToken().value.includes("-")) {
          this.tokens.replaceToken(`'${this.tokens.currentToken().value}'`);
        } else {
          this.tokens.copyToken();
        }
        this.tokens.replaceToken(": ");
        if (this.tokens.matches1(tt.braceL)) {
          this.tokens.replaceToken("");
          this.rootTransformer.processBalancedCode();
          this.tokens.replaceToken("");
        } else {
          this.processStringPropValue();
        }
      } else if (this.tokens.matches1(tt.jsxName)) {
        this.tokens.copyToken();
        this.tokens.appendCode(": true");
      } else if (this.tokens.matches1(tt.braceL)) {
        this.tokens.replaceToken("");
        this.rootTransformer.processBalancedCode();
        this.tokens.replaceToken("");
      } else {
        break;
      }
      this.tokens.appendCode(",");
    }
    this.tokens.appendCode(` ${devProps}}`);
  }

  processStringPropValue(): void {
    const value = this.tokens.currentToken().value;
    const replacementCode = formatJSXTextReplacement(value);
    const literalCode = formatJSXStringValueLiteral(value);
    this.tokens.replaceToken(literalCode + replacementCode);
  }

  /**
   * Process the first part of a tag, before any props.
   */
  processTagIntro(): void {
    // Walk forward until we see one of these patterns:
    // jsxName to start the first prop, preceded by another jsxName to end the tag name.
    // [open brace] to start the first prop.
    // [jsxTagEnd] to end the open-tag.
    // [slash, jsxTagEnd] to end the self-closing tag.
    let introEnd = this.tokens.currentIndex() + 1;
    while (
      !this.tokens.matchesAtIndex(introEnd - 1, ["jsxName", "jsxName"]) &&
      !this.tokens.matchesAtIndex(introEnd, ["{"]) &&
      !this.tokens.matchesAtIndex(introEnd, ["jsxTagEnd"]) &&
      !this.tokens.matchesAtIndex(introEnd, ["/", "jsxTagEnd"])
    ) {
      introEnd++;
    }
    if (
      introEnd === this.tokens.currentIndex() + 1 &&
      startsWithLowerCase(this.tokens.currentToken().value)
    ) {
      this.tokens.replaceToken(`'${this.tokens.currentToken().value}'`);
    }
    while (this.tokens.currentIndex() < introEnd) {
      this.rootTransformer.processToken();
    }
  }

  processChildren(): void {
    while (true) {
      if (this.tokens.matches2(tt.jsxTagStart, tt.slash)) {
        // Closing tag, so no more children.
        return;
      }
      if (this.tokens.matches1(tt.braceL)) {
        if (this.tokens.matches2(tt.braceL, tt.braceR)) {
          // Empty interpolations and comment-only interpolations are allowed
          // and don't create an extra child arg.
          this.tokens.replaceToken("");
          this.tokens.replaceToken("");
        } else {
          // Interpolated expression.
          this.tokens.replaceToken(", ");
          this.rootTransformer.processBalancedCode();
          this.tokens.replaceToken("");
        }
      } else if (this.tokens.matches1(tt.jsxTagStart)) {
        // Child JSX element
        this.tokens.appendCode(", ");
        this.processJSXTag();
      } else if (this.tokens.matches1(tt.jsxText)) {
        this.processChildTextElement();
      } else {
        throw new Error("Unexpected token when processing JSX children.");
      }
    }
  }

  processChildTextElement(): void {
    const value = this.tokens.currentToken().value;
    const replacementCode = formatJSXTextReplacement(value);
    const literalCode = formatJSXTextLiteral(value);
    if (literalCode === '""') {
      this.tokens.replaceToken(replacementCode);
    } else {
      this.tokens.replaceToken(`, ${literalCode}${replacementCode}`);
    }
  }

  processJSXTag(): void {
    const resolvedReactName = this.importProcessor.getIdentifierReplacement("React") || "React";
    const firstTokenStart = this.tokens.currentToken().start;
    // First tag is always jsxTagStart.
    this.tokens.replaceToken(`${resolvedReactName}.createElement(`);
    this.processTagIntro();
    this.processProps(firstTokenStart);

    if (this.tokens.matches2(tt.slash, tt.jsxTagEnd)) {
      // Self-closing tag.
      this.tokens.replaceToken("");
      this.tokens.replaceToken(")");
    } else if (this.tokens.matches1(tt.jsxTagEnd)) {
      this.tokens.replaceToken("");
      // Tag with children.
      this.processChildren();
      while (!this.tokens.matches1(tt.jsxTagEnd)) {
        this.tokens.replaceToken("");
      }
      this.tokens.replaceToken(")");
    } else {
      throw new Error("Expected either /> or > at the end of the tag.");
    }
  }
}

function startsWithLowerCase(s: string): boolean {
  return s[0] === s[0].toLowerCase();
}

/**
 * Turn the given jsxText string into a JS string literal. Leading and trailing
 * whitespace on lines is removed, except immediately after the open-tag and
 * before the close-tag. Empty lines are completely removed, and spaces are
 * added between lines after that.
 *
 * We use JSON.stringify to introduce escape characters as necessary, and trim
 * the start and end of each line and remove blank lines.
 */
function formatJSXTextLiteral(text: string): string {
  let result = "";
  let whitespace = "";

  let isInInitialLineWhitespace = false;
  let seenNonWhitespace = false;
  for (const c of text) {
    if (c === " " || c === "\t") {
      if (!isInInitialLineWhitespace) {
        whitespace += c;
      }
    } else if (c === "\n") {
      whitespace = "";
      isInInitialLineWhitespace = true;
    } else {
      if (seenNonWhitespace && isInInitialLineWhitespace) {
        result += " ";
      }
      result += whitespace;
      whitespace = "";
      result += c;
      seenNonWhitespace = true;
      isInInitialLineWhitespace = false;
    }
  }
  if (!isInInitialLineWhitespace) {
    result += whitespace;
  }
  return JSON.stringify(result);
}

/**
 * Produce the code that should be printed after the JSX text string literal,
 * with most content removed, but all newlines preserved and all spacing at the
 * end preserved.
 */
function formatJSXTextReplacement(text: string): string {
  let numNewlines = 0;
  let numSpaces = 0;
  for (const c of text) {
    if (c === "\n") {
      numNewlines++;
      numSpaces = 0;
    } else if (c === " ") {
      numSpaces++;
    }
  }
  return "\n".repeat(numNewlines) + " ".repeat(numSpaces);
}

/**
 * Format a string in the value position of a JSX prop.
 *
 * Use the same implementation as convertAttribute from
 * babel-helper-builder-react-jsx.
 */
function formatJSXStringValueLiteral(text: string): string {
  return JSON.stringify(text.replace(/\n\s+/g, " "));
}
