import fs from "fs";
import * as ohm from "ohm-js";
import prettier from "prettier";
import invariant from "tiny-invariant";

const TYPEOF_CHECKS = new Set(["number", "string", "boolean"]);

function isBuiltInType(ref: AGBaseNodeRef): ref is BuiltinType {
  return ref.ref === "Raw";
}

type BuiltinType = { ref: "Raw"; name: string };

// e.g. "MyNode" or "@MyUnion"
type AGBaseNodeRef =
  | BuiltinType // e.g. `boolean`, or `string | boolean`
  | { ref: "Node"; name: string }
  | { ref: "NodeUnion"; name: string };

// e.g. "MyNode+" or "@MyUnion*"
type AGPattern =
  | AGBaseNodeRef
  | {
      ref: "List";
      of: AGBaseNodeRef;
      min: 0 | 1;
    };

// e.g. "MyNode?" or "@MyUnion*?"
type AGNodeRef =
  | AGPattern
  | {
      ref: "Optional";
      of: AGPattern;
    };

// e.g. ['FloatLiteral', 'IntLiteral', '@StringExpr']
type AGUnionDef = {
  name: string;
  members: AGNodeRef[];
};

type AGField = {
  name: string;
  ref: AGNodeRef;
};

type AGNodeDef = {
  name: string;
  fieldsByName: LUT<AGField>;
  fields: AGField[];
};

type LUT<T> = { [key: string]: T };

type AGGrammar = {
  startNode: string;

  nodesByName: LUT<AGNodeDef>;
  nodes: AGNodeDef[]; // Sorted list of nodes

  unionsByName: LUT<AGUnionDef>;
  unions: AGUnionDef[]; // Sorted list of node unions
};

function takeWhile<T>(items: T[], predicate: (item: T) => boolean): T[] {
  const result = [];
  for (const item of items) {
    if (predicate(item)) {
      result.push(item);
    } else {
      break;
    }
  }
  return result;
}

function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const gold: T[] = [];
  const dirt: T[] = [];
  for (const item of items) {
    if (predicate(item)) {
      gold.push(item);
    } else {
      dirt.push(item);
    }
  }
  return [gold, dirt];
}

function lowercaseFirst(text: string): string {
  return text[0].toLowerCase() + text.slice(1);
}

function parseBaseNodeRef(spec: string): AGBaseNodeRef {
  const match = spec.match(/^((@?[a-z]+)|`[a-z\s|]+`)$/i);
  invariant(match, `Invalid reference: "${spec}"`);
  if (spec.startsWith("@")) {
    return {
      ref: "NodeUnion",
      name: spec.slice(1),
    };
  } else if (spec.startsWith("`")) {
    return {
      ref: "Raw",
      name: spec.slice(1, -1),
    };
  } else {
    return {
      ref: "Node",
      name: spec,
    };
  }
}

function parseListOfNodeRef(spec: string): AGPattern {
  if (spec.endsWith("*")) {
    return {
      ref: "List",
      of: parseBaseNodeRef(spec.slice(0, -1)),
      min: 0,
    };
  } else if (spec.endsWith("+")) {
    return {
      ref: "List",
      of: parseBaseNodeRef(spec.slice(0, -1)),
      min: 1,
    };
  } else {
    return parseBaseNodeRef(spec);
  }
}

function parseSpec(spec: string): AGNodeRef {
  if (spec.endsWith("?")) {
    return {
      ref: "Optional",
      of: parseListOfNodeRef(spec.substring(0, spec.length - 1)),
    };
  } else {
    return parseListOfNodeRef(spec);
  }
}

/**
 * Given a NodeRef instance, returns its formatted string, e.g. "@MyNode*"
 */
function serializeRef(ref: AGNodeRef): string {
  if (ref.ref === "Optional") {
    return serializeRef(ref.of) + "?";
  } else if (ref.ref === "List") {
    const base = serializeRef(ref.of);
    if (ref.min > 0) {
      return base + "+";
    } else {
      return base + "*";
    }
  } else if (ref.ref === "NodeUnion") {
    return "@" + ref.name;
  } else if (ref.ref === "Node") {
    return ref.name;
  } else {
    return ref.name;
  }
}

function getBaseNodeRef(ref: AGNodeRef): AGBaseNodeRef {
  return ref.ref === "Optional"
    ? getBaseNodeRef(ref.of)
    : ref.ref === "List"
      ? getBaseNodeRef(ref.of)
      : ref;
}

function getBareRef(ref: AGNodeRef): string {
  return ref.ref === "Optional"
    ? getBareRef(ref.of)
    : ref.ref === "List"
      ? getBareRef(ref.of)
      : ref.ref === "Node"
        ? ref.name
        : ref.ref === "NodeUnion"
          ? ref.name
          : ref.name;
}

function getBareRefTarget(ref: AGNodeRef): "Node" | "NodeUnion" | "Raw" {
  return ref.ref === "Optional" || ref.ref === "List"
    ? getBareRefTarget(ref.of)
    : ref.ref;
}

function getTypeScriptType(ref: AGNodeRef): string {
  return ref.ref === "Optional"
    ? getTypeScriptType(ref.of) + " | null"
    : ref.ref === "List"
      ? getTypeScriptType(ref.of) + "[]"
      : isBuiltInType(ref)
        ? ref.name
        : ref.name;
}

function validate(grammar: AGGrammar) {
  // Keep track of which node names are referenced/used
  const referenced: Set<string> = new Set();

  for (const nodeUnion of grammar.unions) {
    for (const ref of nodeUnion.members) {
      const memberName = getBareRef(ref);
      referenced.add(memberName);
      invariant(
        grammar.nodesByName[memberName] ||
          (nodeUnion.name !== memberName && !!grammar.unionsByName[memberName]),
        `Member "${memberName}" of union "${nodeUnion.name}" is not defined in the grammar`,
      );
    }
  }

  for (const node of grammar.nodes) {
    for (const field of node.fields) {
      invariant(
        !field.name.startsWith("_"),
        `Illegal field name: "${node.name}.${field.name}" (fields starting with "_" are reserved)`,
      );
      const bare = getBareRef(field.ref);
      const base = getBaseNodeRef(field.ref);
      referenced.add(bare);
      invariant(
        isBuiltInType(base) ||
          !!grammar.unionsByName[bare] ||
          !!grammar.nodesByName[bare],
        `Unknown node kind "${bare}" (in "${node.name}.${field.name}")`,
      );
    }
  }

  // Check that all defined nodes are referenced
  const unreferenced = new Set(grammar.nodes.map((n) => n.name));
  for (const name of referenced) {
    unreferenced.delete(name);
  }

  unreferenced.delete(grammar.startNode);
  invariant(
    unreferenced.size === 0,
    `The following node kinds are never referenced: ${Array.from(
      unreferenced,
    ).join(", ")}`,
  );
}

function generateAssertParam(
  fieldName: string, // actualKindValue
  fieldRef: AGNodeRef, // expectedNode
  currentContext: string,
): string {
  return `assert(${generateTypeCheckCondition(
    fieldRef,
    fieldName,
  )}, \`Invalid value for "${fieldName}" arg in ${JSON.stringify(
    currentContext,
  )} call.\\nExpected: ${serializeRef(
    fieldRef,
  )}\\nGot:      \${JSON.stringify(${fieldName})}\`)`;
}

function generateTypeCheckCondition(
  expected: AGNodeRef,
  actualValue: string,
): string {
  const conditions = [];

  if (expected.ref === "Optional") {
    conditions.push(
      `${actualValue} === null || ${generateTypeCheckCondition(
        expected.of,
        actualValue,
      )}`,
    );
  } else if (expected.ref === "List") {
    conditions.push(`Array.isArray(${actualValue})`);
    if (expected.min > 0) {
      conditions.push(`${actualValue}.length > 0`);
    }
    conditions.push(
      `${actualValue}.every(item => ${generateTypeCheckCondition(
        expected.of,
        "item",
      )})`,
    );
  } else if (expected.ref === "NodeUnion") {
    conditions.push(`is${expected.name}(${actualValue})`);
  } else if (isBuiltInType(expected)) {
    conditions.push(
      `( ${expected.name
        .replace(/`/g, "")
        .split("|")
        .flatMap((part) => {
          part = part.trim();
          if (TYPEOF_CHECKS.has(part)) {
            return [`typeof ${actualValue} === ${JSON.stringify(part)}`];
          } else if (part === "null") {
            return [`${actualValue} === null`];
          } else {
            console.warn(`Cannot emit runtime type check for ${part}`);
            return [];
          }
        })
        .join(" || ")})`,
    );
  } else {
    conditions.push(
      `${actualValue}._kind === ${JSON.stringify(expected.name)}`,
    );
  }

  return conditions.map((c) => `(${c})`).join(" && ");
}

function parseGrammarFromPath(path: string): AGGrammar {
  const src = fs.readFileSync(path, "utf-8");
  return parseGrammarFromString(src);
}

export function parseGrammarFromString(src: string): AGGrammar {
  return parseGrammarFromString_withOhm(src);
}

const grammar = ohm.grammar(String.raw`
    AstGeneratorGrammar {
      Start = Def+

      // Override Ohm's built-in definition of space
      space := "\u0000".." " | comment
      comment = "#" (~"\n" any)*
      nodename (a node name) = upper alnum*
      identifier (an identifier) = letter alnum*

      Def
        = AGNodeDef
        | AGUnionDef

      AGNodeDef
        = nodename "{" AGField* "}"

      AGUnionDef
        = "@" nodename "=" "|"? NonemptyListOf<AGNodeRef, "|">

      AGField
        = identifier "?"? ":" AGPattern
      
      AGPattern
        = AGNodeRef ("+" | "*")?

      AGNodeRef
        = BuiltinTypeUnion  -- builtin
        | nodename          -- node
        | "@" nodename      -- union

      BuiltinTypeUnion
        = NonemptyListOf<BuiltinType, "|">

      // e.g. \`boolean\`, or \`string | boolean\`
      BuiltinType
        = "string"
        | "number"
        | "boolean"
        | "null"
    }
  `);

const semantics = grammar.createSemantics();

semantics.addAttribute<
  | AGGrammar
  | AGNodeDef
  | AGUnionDef
  | AGField
  | AGPattern
  | AGNodeRef
  | BuiltinType
  | string
>("ast", {
  nodename(_upper, _alnum): string { return this.sourceString }, // prettier-ignore
  identifier(_letter, _alnum): string { return this.sourceString }, // prettier-ignore

  Start(defList): AGGrammar {
    const defs = defList.children.map((d) => d.ast as AGNodeDef | AGUnionDef);

    const unionsByName: LUT<AGUnionDef> = {};
    const nodesByName: LUT<AGNodeDef> = {};

    for (const def of defs) {
      if ("members" in def) {
        unionsByName[def.name] = def;
      } else {
        nodesByName[def.name] = def;
      }
    }

    return {
      // The first-defined node in the document is the start node
      startNode: Object.keys(nodesByName)[0],

      nodesByName,
      nodes: Object.keys(nodesByName)
        .sort()
        .map((name) => nodesByName[name]),

      unionsByName,
      unions: Object.keys(unionsByName)
        .sort()
        .map((name) => unionsByName[name]),
    };
  },

  AGNodeDef(name, _lbracket, fieldList, _rbracket): AGNodeDef {
    const fields = fieldList.children.map((f) => f.ast);
    const fieldsByName = index(fields, (f) => f.name);
    return {
      name: name.ast,
      fieldsByName,
      fields,
    };
  },

  AGUnionDef(_at, name, _eq, _pipe, memberList): AGUnionDef {
    return {
      name: name.ast,
      members: memberList.asIteration().children.map((m) => m.ast),
    };
  },

  AGField(name, qmark, _colon, pattern): AGField {
    let ref = pattern.ast;
    if (qmark.children.length > 0) {
      ref = { ref: "Optional", of: ref };
    }
    return { name: name.ast, ref };
  },

  AGPattern(refNode, multiplier): AGPattern {
    let ref = refNode.ast;
    if (multiplier.children.length > 0) {
      const op = multiplier.children[0].sourceString;
      ref = { ref: "List", of: ref, min: op === "+" ? 1 : 0 };
    }
    return ref;
  },

  AGNodeRef_node(nodename): AGBaseNodeRef {
    return { ref: "Node", name: nodename.ast };
  },

  AGNodeRef_union(_at, nodename): AGBaseNodeRef {
    return { ref: "NodeUnion", name: nodename.ast };
  },

  BuiltinTypeUnion(list): BuiltinType {
    return {
      ref: "Raw",
      name: list.sourceString,
    };
  },
});

semantics.addOperation<ohm.Node[]>("allRefs", {
  _terminal() {
    return [];
  },
  _nonterminal(...children) {
    return children.flatMap((c) => c.allRefs());
  },
  _iter(...children) {
    return children.flatMap((c) => c.allRefs());
  },
  AGNodeRef_node(_nodename) {
    return [this];
  },
  AGNodeRef_union(_at, _nodename) {
    return [this];
  },
});

semantics.addOperation<void>("check", {
  Start(defList): void {
    const validNames = new Set<string>();

    const nodeDefs: AGNodeDef[] = [];
    const unionDefs: AGUnionDef[] = [];

    // Do a pass over all defined nodes
    for (const def of defList.children) {
      if (validNames.has(def.ast.name)) {
        throw new Error(
          def.source.getLineAndColumnMessage() +
            `Duplicate definition of '${def.ast.name}'`,
        );
      }

      validNames.add(def.ast.name);
      const astNode = def.ast;
      if ("members" in astNode) {
        unionDefs.push(astNode);
      } else {
        nodeDefs.push(astNode);
      }
    }

    // Do a pass over all node references
    const nodeNames: string[] = nodeDefs.map((d) => d.name);
    const unionNames: string[] = unionDefs.map((d) => d.name);

    const unused: Set<string> = new Set(validNames);

    // Remove the start node's name
    unused.delete(this.ast.startNode);

    for (const ohmNode of this.allRefs() as ohm.Node[]) {
      const astNode = ohmNode.ast;
      unused.delete(astNode.name);

      // Check that all MyNode refs are valid
      if (astNode.ref === "Node") {
        if (!nodeNames.includes(astNode.name)) {
          throw new Error(
            ohmNode.source.getLineAndColumnMessage() +
              `Cannot find '${astNode.name}'`,
          );
        }
      }

      // Check that all @MyUnion refs are valid
      if (astNode.ref === "NodeUnion") {
        if (!unionNames.includes(astNode.name)) {
          throw new Error(
            ohmNode.source.getLineAndColumnMessage() +
              `Cannot find '@${astNode.name}'`,
          );
        }
      }
    }

    if (unused.size > 0) {
      const [name] = unused;
      const def = defList.children.find((def) => def.ast.name === name)!;
      throw new Error(
        def.children[0].source.getLineAndColumnMessage() +
          `Unused definition '${"members" in def.ast ? "@" : ""}${name}'`,
      );
    }
  },
});

function index<T>(arr: T[], keyFn: (item: T) => string): LUT<T> {
  const result: LUT<T> = {};
  for (const item of arr) {
    result[keyFn(item)] = item;
  }
  return result;
}

export function parseGrammarFromString_withOhm(text: string): AGGrammar {
  const parsed = grammar.match(text);
  if (parsed.message) {
    throw new Error(parsed.message);
  }

  const tree = semantics(parsed);
  tree.check(); // Will throw in case of errors
  return tree.ast;
}

export function parseGrammarFromString_withClassic(src: string): AGGrammar {
  const lines = src
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const unionsByName: LUT<AGUnionDef> = {};
  const nodesByName: LUT<AGNodeDef> = {};

  let currUnion: AGNodeRef[] | void;
  let currNode: LUT<AGField> | void;

  for (let line of lines) {
    if (line.endsWith(":")) {
      line = line.substring(0, line.length - 1).trim();

      // NodeUnion or Node?
      if (line.startsWith("@")) {
        currUnion = [];
        currNode = undefined;
        unionsByName[line.substring(1)] = {
          name: line.substring(1),
          members: currUnion,
        };
      } else {
        currNode = {};
        currUnion = undefined;
        nodesByName[line] = {
          name: line,
          fieldsByName: currNode,
          fields: [], // Will be populated in a later pass
        };
      }
      continue;
    }

    if (line.startsWith("|")) {
      const union = line.substring(1).trim();
      invariant(currUnion, "Expect a current union");
      currUnion.push(parseBaseNodeRef(union));
    } else {
      const [name, ...rest] = line.split(/\s+/);
      const spec = rest.join(" ");
      invariant(currNode, "Expect a current node");
      currNode[name] = { name, ref: parseSpec(spec) };
    }
  }

  // Populate all the fields, for easier looping later
  for (const node of Object.values(nodesByName)) {
    node.fields = Object.values(node.fieldsByName);
  }

  return {
    // The first-defined node in the document is the start node
    startNode: Object.keys(nodesByName)[0],

    nodesByName,
    nodes: Object.keys(nodesByName)
      .sort()
      .map((name) => nodesByName[name]),

    unionsByName,
    unions: Object.keys(unionsByName)
      .sort()
      .map((name) => unionsByName[name]),
  };
}

function generateCode(grammar: AGGrammar): string {
  // Will throw in case of errors
  validate(grammar);

  const output = [
    "/**",
    " * This file is AUTOMATICALLY GENERATED.",
    " * DO NOT edit this file manually.",
    " *",
    " * Instead, update the `ast.grammar` file, and re-run `npm run build-ast`",
    " */",
    "",
    `
    const DEBUG = process.env.NODE_ENV !== 'production';

    function assert(condition: boolean, errmsg: string): asserts condition {
      if (condition) return;
      throw new Error(errmsg);
    }

    function assertRange(range: unknown, currentContext: string): asserts range is Range {
      assert(
        isRange(range),
        \`Invalid value for range in "\${JSON.stringify(currentContext)}".\\nExpected: Range\\nGot: \${JSON.stringify(range)}\`
      );
    }

    function asNode<N extends Node>(node: N): N {
      return Object.defineProperty(node, 'range', { enumerable: false });
    }

    `,
  ];

  for (const union of grammar.unions) {
    const [subNodes, subUnions] = partition(
      union.members,
      (ref) => getBareRefTarget(ref) === "Node",
    );
    const conditions = subNodes
      .map((ref) => `node._kind === ${JSON.stringify(getBareRef(ref))}`)
      .concat(subUnions.map((ref) => `is${getBareRef(ref)}(node)`));
    output.push(`
          export function is${union.name}(node: Node): node is ${union.name} {
            return (
              ${conditions.join(" || ")}
            )
          }
        `);
  }

  for (const union of grammar.unions) {
    output.push(`
            export type ${union.name} =
                ${union.members
                  .map((member) => `${getBareRef(member)}`)
                  .join(" | ")};
            `);
  }

  output.push(`
        export type Range = [number, number]

        export type Node = ${grammar.nodes.map((node) => node.name).join(" | ")}

        export function isRange(thing: unknown): thing is Range {
            return (
                Array.isArray(thing)
                && thing.length === 2
                && typeof thing[0] === 'number'
                && typeof thing[1] === 'number'
            )
        }

        export function isNode(node: Node): node is Node {
            return (
                ${grammar.nodes
                  .map((node) => `node._kind === ${JSON.stringify(node.name)}`)
                  .join(" || ")}
            )
        }
    `);

  for (const node of grammar.nodes) {
    output.push(`
            export type ${node.name} = {
                _kind: ${JSON.stringify(node.name)}
                ${node.fields
                  .map(
                    (field) => `${field.name}: ${getTypeScriptType(field.ref)}`,
                  )
                  .join("\n")}
                range: Range
            }
        `);
  }

  output.push("");
  for (const node of grammar.nodes) {
    const optionals = new Set(
      takeWhile(
        node.fields.slice().reverse(),
        (field) =>
          field.ref.ref === "Optional" ||
          (field.ref.ref === "List" && field.ref.min === 0),
      ).map((field) => field.name),
    );

    const runtimeTypeChecks = node.fields.map((field) =>
      generateAssertParam(field.name, field.ref, node.name),
    );
    runtimeTypeChecks.push(`assertRange(range, ${JSON.stringify(node.name)})`);

    output.push(`
      export function ${lowercaseFirst(node.name)}(${[
        ...node.fields.map((field) => {
          const key = field.name;
          const type = getTypeScriptType(field.ref);
          return optionals.has(field.name)
            ? `${key}: ${type} = ${field.ref.ref === "Optional" ? "null" : "[]"}`
            : `${key}: ${type}`;
        }),
        "range: Range = [0, 0]",
      ].join(", ")}): ${node.name} {
                ${
                  runtimeTypeChecks.length > 0
                    ? `DEBUG && (() => { ${runtimeTypeChecks.join("\n")} })()`
                    : ""
                }
                return asNode({
                    _kind: ${JSON.stringify(node.name)},
                    ${[...node.fields.map((field) => field.name), "range"].join(
                      ", ",
                    )}
                });
            }
            `);
  }

  // Generate a general purpose AST traversal/visit function
  output.push("interface Visitor<TContext> {");
  for (const node of grammar.nodes) {
    output.push(
      `  ${node.name}?(node: ${node.name}, context: TContext): void;`,
    );
  }
  output.push("}");

  output.push(
    `
      export function visit<TNode extends Node>(node: TNode, visitor: Visitor<undefined>): TNode;
      export function visit<TNode extends Node, TContext>(node: TNode, visitor: Visitor<TContext>, context: TContext): TNode;
      export function visit<TNode extends Node, TContext>(node: TNode, visitor: Visitor<TContext | undefined>, context?: TContext): TNode {
        switch (node._kind) {
        `,
  );

  for (const node of grammar.nodes) {
    const fields = node.fields.filter(
      (field) => !isBuiltInType(getBaseNodeRef(field.ref)),
    );

    output.push(`case ${JSON.stringify(node.name)}:`);
    output.push(`  visitor.${node.name}?.(node, context);`);
    for (const field of fields) {
      switch (field.ref.ref) {
        case "Node":
        case "NodeUnion":
          output.push(`  visit(node.${field.name}, visitor, context);`);
          break;

        case "List":
          output.push(
            `  node.${field.name}.forEach(${field.name[0]} => visit(${field.name[0]}, visitor, context));`,
          );
          break;

        case "Optional":
          output.push(
            `  // TODO: Implement visiting for _optional_ field node.${field.name}`,
          );
          break;
      }
    }
    output.push("  break;");
    output.push("");
  }

  output.push(
    `
        }

        return node;
      }
      `,
  );

  return output.join("\n");
}

function writeFile(contents: string, path: string) {
  const existing = fs.existsSync(path)
    ? fs.readFileSync(path, { encoding: "utf-8" })
    : null;
  if (contents !== existing) {
    fs.writeFileSync(path, contents, { encoding: "utf-8" });
    console.error(`Wrote ${path}`);
  } else {
    // Output file is still up to date, let's not write (since it may
    // trigger another watch proc)
  }
}

export async function generateAST(
  inpath: string,
  outpath: string,
): Promise<void> {
  const grammar = parseGrammarFromPath(inpath);
  const uglyCode = generateCode(grammar);

  // Beautify it with prettier
  const config = await prettier.resolveConfig(outpath);
  if (config === null) {
    throw new Error(
      "Could not find or read .prettierrc config for this project",
    );
  }

  const code = await prettier.format(uglyCode, {
    ...config,
    parser: "typescript",
  });
  writeFile(code, outpath);
}
