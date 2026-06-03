/**
 * Code AST Parser
 * 
 * Parses source code into AST nodes using regex-based parsing.
 * Supports TypeScript, JavaScript, and Python.
 * 
 * Note: This is a lightweight parser. For full AST parsing,
 * consider integrating tree-sitter in the future.
 */

import {
  type AstNode,
  type AstParser,
  type ContentType,
  type ParseOptions,
  type ParseResult,
} from "../types.js";
import {
  createNode,
  createRange,
  createPosition,
  createRelation,
} from "../ast-engine.js";

/** Code parser implementation */
export class CodeParser implements AstParser {
  readonly name = "code";
  readonly supportedTypes: ContentType[] = ["typescript", "javascript", "python"];

  canParse(content: string, typeHint?: ContentType): boolean {
    if (typeHint && this.supportedTypes.includes(typeHint)) return true;
    
    const trimmed = content.trim();
    return /\b(function|const|let|var|class|interface|import|export|async|await)\b/.test(trimmed) ||
           /\b(def|class|import|from|async|await)\b/.test(trimmed);
  }

  parse(content: string, options: ParseOptions = {}): ParseResult {
    const startTime = performance.now();
    const lines = content.split("\n");
    const nodes = new Map<string, AstNode>();
    const relations: ReturnType<typeof createRelation>[] = [];

    const contentType = options.contentType ?? this.detectLanguage(content);

    // Create root document node
    const root = createNode(
      "document",
      this.extractFileName(content) || "Source Code",
      content,
      createRange(
        createPosition(1, 0, 0),
        createPosition(lines.length, 0, content.length)
      ),
      { contentType }
    );
    nodes.set(root.id, root);

    // Parse imports
    const imports = this.parseImports(content, contentType, root.id);
    for (const imp of imports) {
      nodes.set(imp.id, imp);
      relations.push(createRelation(root.id, imp.id, "contains"));
      root.childrenIds.push(imp.id);
    }

    // Parse classes
    const classes = this.parseClasses(content, contentType, root.id);
    for (const cls of classes) {
      nodes.set(cls.id, cls);
      relations.push(createRelation(root.id, cls.id, "contains"));
      root.childrenIds.push(cls.id);

      // Parse methods within class
      const methods = this.parseMethods(cls.content, contentType, cls.id);
      for (const method of methods) {
        nodes.set(method.id, method);
        relations.push(createRelation(cls.id, method.id, "contains"));
        cls.childrenIds.push(method.id);
      }
    }

    // Parse standalone functions
    const functions = this.parseFunctions(content, contentType, root.id, classes);
    for (const func of functions) {
      nodes.set(func.id, func);
      relations.push(createRelation(root.id, func.id, "contains"));
      root.childrenIds.push(func.id);
    }

    // Parse interfaces (TypeScript only)
    if (contentType === "typescript") {
      const interfaces = this.parseInterfaces(content, root.id);
      for (const iface of interfaces) {
        nodes.set(iface.id, iface);
        relations.push(createRelation(root.id, iface.id, "contains"));
        root.childrenIds.push(iface.id);
      }
    }

    // Build cross-references
    this.buildCrossReferences(nodes, relations, content);

    const duration = performance.now() - startTime;

    return {
      root,
      nodes,
      relations,
      contentType,
      stats: {
        totalNodes: nodes.size,
        maxDepth: this.calculateMaxDepth(nodes),
        durationMs: duration,
      },
    };
  }

  /** Detect programming language */
  private detectLanguage(content: string): ContentType {
    const trimmed = content.trim();
    
    if (/\b(def|class|import|from)\b/.test(trimmed) && 
        /:\s*$|:\s*#/.test(trimmed)) {
      return "python";
    }
    
    if (/\b(interface|type\s+\w+\s*=|enum\s+\w+\s*\{)\b/.test(trimmed)) {
      return "typescript";
    }
    
    return "javascript";
  }

  /** Extract file name from content (if available in comments) */
  private extractFileName(content: string): string | null {
    const match = content.match(/@filename\s+(\S+)/);
    return match ? match[1] : null;
  }

  /** Parse import statements */
  private parseImports(content: string, language: ContentType, parentId: string): AstNode[] {
    const imports: AstNode[] = [];

    if (language === "python") {
      // Python imports: import x, from x import y
      const regex = /^(?:from\s+(\S+)\s+)?import\s+(.+)$/gm;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const moduleName = match[1] || match[2].split(/\s*,\s*/)[0].trim();
        const startOffset = match.index;
        
        imports.push(createNode(
          "import",
          `import ${moduleName}`,
          match[0],
          createRange(
            createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
            createPosition(this.getLineNumber(content, startOffset + match[0].length), 0, startOffset + match[0].length)
          ),
          {
            parentId,
            contentType: language,
            metadata: { moduleName },
          }
        ));
      }
    } else {
      // JS/TS imports: import x from 'y', import { x } from 'y'
      const regex = /^import\s+(?:(\*|\{[^}]+\}|\w+)\s+from\s+)?['"]([^'"]+)['"];?/gm;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const moduleName = match[2];
        const startOffset = match.index;
        
        imports.push(createNode(
          "import",
          `import from ${moduleName}`,
          match[0],
          createRange(
            createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
            createPosition(this.getLineNumber(content, startOffset + match[0].length), 0, startOffset + match[0].length)
          ),
          {
            parentId,
            contentType: language,
            metadata: { moduleName },
          }
        ));
      }
    }

    return imports;
  }

  /** Parse class declarations */
  private parseClasses(content: string, language: ContentType, parentId: string): AstNode[] {
    const classes: AstNode[] = [];
    
    if (language === "python") {
      // Python classes: class MyClass(Base):
      const regex = /^class\s+(\w+)(?:\(([^)]*)\))?:\s*(?:#.*)?$/gm;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const className = match[1];
        const extendsClass = match[2] || null;
        const startOffset = match.index;
        const classContent = this.extractBlock(content, startOffset, language);
        
        const cls = createNode(
          "class",
          className,
          classContent,
          createRange(
            createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
            createPosition(this.getLineNumber(content, startOffset + classContent.length), 0, startOffset + classContent.length)
          ),
          {
            parentId,
            contentType: language,
            metadata: { className, extends: extendsClass },
          }
        );
        classes.push(cls);
      }
    } else {
      // JS/TS classes: class MyClass extends Base { }
      const regex = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const className = match[1];
        const extendsClass = match[2] || null;
        const startOffset = match.index;
        const classContent = this.extractBlock(content, startOffset, language);
        
        const cls = createNode(
          "class",
          className,
          classContent,
          createRange(
            createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
            createPosition(this.getLineNumber(content, startOffset + classContent.length), 0, startOffset + classContent.length)
          ),
          {
            parentId,
            contentType: language,
            metadata: { className, extends: extendsClass },
          }
        );
        classes.push(cls);
      }
    }

    return classes;
  }

  /** Parse function declarations */
  private parseFunctions(
    content: string,
    language: ContentType,
    parentId: string,
    existingClasses: AstNode[]
  ): AstNode[] {
    const functions: AstNode[] = [];
    
    if (language === "python") {
      // Python functions: def my_func(params):
      const regex = /^(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*-\u003e\s*[^:]+)?:\s*(?:#.*)?$/gm;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const funcName = match[1];
        const startOffset = match.index;
        
        // Skip if inside a class
        if (this.isInsideClass(startOffset, existingClasses)) continue;
        
        const funcContent = this.extractBlock(content, startOffset, language);
        
        functions.push(createNode(
          "function",
          funcName,
          funcContent,
          createRange(
            createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
            createPosition(this.getLineNumber(content, startOffset + funcContent.length), 0, startOffset + funcContent.length)
          ),
          {
            parentId,
            contentType: language,
            metadata: { functionName: funcName, isAsync: match[0].startsWith("async") },
          }
        ));
      }
    } else {
      // JS/TS functions: function name(), const name = () => {}, async function name()
      const patterns = [
        // Regular functions
        /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g,
        // Arrow functions with const/let
        /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
        // Method definitions (in objects)
        /(\w+)\s*\([^)]*\)\s*\{/g,
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const funcName = match[1];
          const startOffset = match.index;
          
          // Skip if inside a class
          if (this.isInsideClass(startOffset, existingClasses)) continue;
          
          const funcContent = this.extractBlock(content, startOffset, language);
          
          functions.push(createNode(
            "function",
            funcName,
            funcContent,
            createRange(
              createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
              createPosition(this.getLineNumber(content, startOffset + funcContent.length), 0, startOffset + funcContent.length)
            ),
            {
              parentId,
              contentType: language,
              metadata: { functionName: funcName },
            }
          ));
        }
      }
    }

    return functions;
  }

  /** Parse methods within a class */
  private parseMethods(classContent: string, language: ContentType, parentId: string): AstNode[] {
    const methods: AstNode[] = [];
    
    if (language === "python") {
      const regex = /^(?:async\s+)?def\s+(\w+)\s*\(self[^)]*\)(?:\s*-\u003e\s*[^:]+)?:\s*(?:#.*)?$/gm;
      let match;
      while ((match = regex.exec(classContent)) !== null) {
        const methodName = match[1];
        const startOffset = match.index;
        const methodContent = this.extractBlock(classContent, startOffset, language);
        
        methods.push(createNode(
          "function",
          methodName,
          methodContent,
          createRange(
            createPosition(this.getLineNumber(classContent, startOffset), 0, startOffset),
            createPosition(this.getLineNumber(classContent, startOffset + methodContent.length), 0, startOffset + methodContent.length)
          ),
          {
            parentId,
            contentType: language,
            metadata: { functionName: methodName, isMethod: true },
          }
        ));
      }
    } else {
      const regex = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g;
      let match;
      while ((match = regex.exec(classContent)) !== null) {
        const methodName = match[1];
        // Skip constructor
        if (methodName === "constructor") continue;
        
        const startOffset = match.index;
        const methodContent = this.extractBlock(classContent, startOffset, language);
        
        methods.push(createNode(
          "function",
          methodName,
          methodContent,
          createRange(
            createPosition(this.getLineNumber(classContent, startOffset), 0, startOffset),
            createPosition(this.getLineNumber(classContent, startOffset + methodContent.length), 0, startOffset + methodContent.length)
          ),
          {
            parentId,
            contentType: language,
            metadata: { functionName: methodName, isMethod: true },
          }
        ));
      }
    }

    return methods;
  }

  /** Parse TypeScript interfaces */
  private parseInterfaces(content: string, parentId: string): AstNode[] {
    const interfaces: AstNode[] = [];
    const regex = /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?\s*\{/g;
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      const interfaceName = match[1];
      const extendsInterface = match[2] ? match[2].trim() : null;
      const startOffset = match.index;
      const interfaceContent = this.extractBlock(content, startOffset, "typescript");
      
      interfaces.push(createNode(
        "interface",
        interfaceName,
        interfaceContent,
        createRange(
          createPosition(this.getLineNumber(content, startOffset), 0, startOffset),
          createPosition(this.getLineNumber(content, startOffset + interfaceContent.length), 0, startOffset + interfaceContent.length)
        ),
        {
          parentId,
          contentType: "typescript",
          metadata: { interfaceName, extends: extendsInterface },
        }
      ));
    }

    return interfaces;
  }

  /** Extract block content (function/class body) */
  private extractBlock(content: string, startOffset: number, language: ContentType): string {
    let braceCount = 0;
    let inString = false;
    let stringChar = '';
    let i = startOffset;
    
    if (language === "python") {
      // Python uses indentation
      const lines = content.slice(startOffset).split("\n");
      let result = lines[0] + "\n";
      const baseIndent = lines[0].match(/^(\s*)/)?.[1].length ?? 0;
      
      for (let j = 1; j < lines.length; j++) {
        const line = lines[j];
        const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
        
        if (line.trim() === "" || indent > baseIndent) {
          result += line + "\n";
        } else if (indent <= baseIndent && line.trim() !== "") {
          break;
        }
      }
      
      return result.trim();
    }

    // C-style braces
    for (; i < content.length; i++) {
      const char = content[i];
      const prevChar = i > 0 ? content[i - 1] : '';

      // Handle strings
      if (!inString && (char === '"' || char === "'" || char === '`')) {
        inString = true;
        stringChar = char;
        continue;
      }
      if (inString && char === stringChar && prevChar !== '\\') {
        inString = false;
        continue;
      }

      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            return content.slice(startOffset, i + 1);
          }
        }
      }
    }

    return content.slice(startOffset);
  }

  /** Check if offset is inside any class */
  private isInsideClass(offset: number, classes: AstNode[]): boolean {
    return classes.some(cls => {
      const start = cls.range.start.offset;
      const end = cls.range.end.offset;
      return offset > start && offset < end;
    });
  }

  /** Build cross-references between nodes */
  private buildCrossReferences(
    nodes: Map<string, AstNode>,
    relations: ReturnType<typeof createRelation>[],
    content: string
  ): void {
    const functionNodes = Array.from(nodes.values()).filter(n => n.type === "function");
    const classNodes = Array.from(nodes.values()).filter(n => n.type === "class");

    // Find function calls within other functions
    for (const func of functionNodes) {
      for (const otherFunc of functionNodes) {
        if (func.id === otherFunc.id) continue;
        
        const callPattern = new RegExp(`\\b${otherFunc.label}\\s*\\(`);
        if (callPattern.test(func.content)) {
          relations.push(createRelation(func.id, otherFunc.id, "calls"));
        }
      }
    }

    // Find class instantiations
    for (const func of functionNodes) {
      for (const cls of classNodes) {
        const instancePattern = new RegExp(`(?:const|let|var|new)\\s+\\w+\\s*=\\s*(?:new\\s+)?${cls.label}\\b`);
        if (instancePattern.test(func.content)) {
          relations.push(createRelation(func.id, cls.id, "depends_on"));
        }
      }
    }

    // Find inheritance
    for (const cls of classNodes) {
      if (cls.metadata.extends) {
        const parentClass = classNodes.find(c => c.label === cls.metadata.extends);
        if (parentClass) {
          relations.push(createRelation(cls.id, parentClass.id, "extends"));
        }
      }
    }
  }

  /** Get line number for offset */
  private getLineNumber(content: string, offset: number): number {
    return content.slice(0, offset).split("\n").length;
  }

  /** Calculate maximum depth */
  private calculateMaxDepth(nodes: Map<string, AstNode>): number {
    let maxDepth = 0;
    for (const [_, node] of nodes) {
      let depth = 0;
      let current: AstNode | undefined = node;
      while (current) {
        depth++;
        current = current.parentId ? nodes.get(current.parentId) : undefined;
      }
      maxDepth = Math.max(maxDepth, depth);
    }
    return maxDepth;
  }
}

/** Create parser instance */
export function createCodeParser(): AstParser {
  return new CodeParser();
}
