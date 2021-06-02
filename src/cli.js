// @flow strict

/**
 * TODO: Originally developed for the Nox programming language, but adjusted
 * for use in other projects to be a bit more general purpose. We can further
 * develop this mini-language and make it powerful enough to power both
 * project's needs.
 */

import type { Options as PrettierOptions } from 'prettier';
import chalk from 'chalk';
import commander from 'commander';
import fs from 'fs';
import invariant from 'invariant';
import prettier from 'prettier';

type ProgramOptions = {|
    inputFile: string,
    outputFile: string,
    discriminator: string, // default: "_kind"
    isBuiltIn: (string) => boolean,
    verbose: boolean,
|};

const PRETTIER_OPTIONS: PrettierOptions = {
    parser: 'flow',
    semi: true,
    printWidth: 90,
    tabWidth: 2,
    singleQuote: true,
    trailingComma: 'all',
};

const DEFAULT_BUILTINS = ['boolean', 'number', 'string'];
const TYPEOF_CHECKS = new Set(['boolean', 'number', 'string']);

// e.g. "SomeNode" or "@SomeGroup"
type BaseNodeRef =
    | {|
          ref: 'Node',
          name: string,
      |}
    | {|
          ref: 'NodeGroup',
          name: string,
      |};

// e.g. "SomeNode+" or "@SomeGroup*"
type MultiNodeRef =
    | BaseNodeRef
    | {|
          ref: 'List',
          of: BaseNodeRef,
          min: 0 | 1,
      |};

// e.g. "SomeNode?" or "@SomeGroup*?"
type NodeRef =
    | MultiNodeRef
    | {|
          ref: 'Optional',
          of: MultiNodeRef,
      |};

// e.g. ['FloatLiteral', 'IntLiteral', '@StringExpr']
type NodeGroup = {|
    name: string,
    members: Array<NodeRef>,
|};

type Constant = {| ref: 'Constant', value: string | number | boolean |};

type FieldValue = NodeRef | Constant;

type Field = {|
    name: string,
    ref: FieldValue,
|};

// e.g. { pattern: '@AssignmentPattern', expr: '@Expr' }
type Node = {|
    name: string,
    fieldsByName: LUT<Field>,
    fields: Array<Field>,
|};

type LUT<T> = {| [key: string]: T |};

type Grammar = {|
    preamble: string | null,

    nodesByName: LUT<Node>,
    nodes: Array<Node>, // Sorted list of nodes

    nodeGroupsByName: LUT<NodeGroup>,
    nodeGroups: Array<NodeGroup>, // Sorted list of node groups
|};

function get<T>(lut: LUT<T>, key: string): T | void {
    return lut[key];
}

function takeWhile<T>(items: Array<T>, predicate: (item: T) => boolean): Array<T> {
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

function partition<T>(
    items: Array<T>,
    predicate: (item: T) => boolean
): [Array<T>, Array<T>] {
    const gold: Array<T> = [];
    const dirt: Array<T> = [];
    for (const item of items) {
        if (predicate(item)) {
            gold.push(item);
        } else {
            dirt.push(item);
        }
    }
    return [gold, dirt];
}

function parseBaseNodeRef(spec: string): BaseNodeRef {
    const match = spec.match(/^([@%]?[a-z]+)$/i);
    invariant(match, `Invalid reference: "${spec}"`);
    if (spec.startsWith('@')) {
        return {
            ref: 'NodeGroup',
            name: spec.substr(1),
        };
    } else {
        return {
            ref: 'Node',
            name: spec,
        };
    }
}

function parseMultiNodeRef(spec: string): MultiNodeRef {
    if (spec.endsWith('*')) {
        return {
            ref: 'List',
            of: parseBaseNodeRef(spec.substring(0, spec.length - 1)),
            min: 0,
        };
    } else if (spec.endsWith('+')) {
        return {
            ref: 'List',
            of: parseBaseNodeRef(spec.substring(0, spec.length - 1)),
            min: 1,
        };
    } else {
        return parseBaseNodeRef(spec);
    }
}

function parseSpec(spec: string): FieldValue {
    try {
        const value = JSON.parse(spec);
        if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        ) {
            return { ref: 'Constant', value };
        }
    } catch {
        // Ignore - not a constant
    }

    if (spec.endsWith('?')) {
        return {
            ref: 'Optional',
            of: parseMultiNodeRef(spec.substring(0, spec.length - 1)),
        };
    } else {
        return parseMultiNodeRef(spec);
    }
}

/**
 * Given a NodeRef instance, returns its formatted string, e.g. "@SomeNode*"
 */
function serializeRef(ref: NodeRef): string {
    if (ref.ref === 'Optional') {
        return serializeRef(ref.of) + '?';
    } else if (ref.ref === 'List') {
        const base = serializeRef(ref.of);
        if (ref.min > 0) {
            return base + '+';
        } else {
            return base + '*';
        }
    } else if (ref.ref === 'NodeGroup') {
        return '@' + ref.name;
    } else {
        return ref.name;
    }
}

function getBareRef(ref: NodeRef): string {
    return ref.ref === 'Optional'
        ? getBareRef(ref.of)
        : ref.ref === 'List'
        ? getBareRef(ref.of)
        : ref.name;
}

function getBareRefTarget(ref: NodeRef): 'Node' | 'NodeGroup' {
    return ref.ref === 'Optional' || ref.ref === 'List'
        ? getBareRefTarget(ref.of)
        : ref.ref;
}

function getTypeScriptType(ref: FieldValue): string {
    return ref.ref === 'Constant'
        ? JSON.stringify(ref.value)
        : ref.ref === 'Optional'
        ? getTypeScriptType(ref.of) + ' | null'
        : ref.ref === 'List'
        ? 'Array<' + getTypeScriptType(ref.of) + '>'
        : ref.name;
}

function validate(grammar: Grammar, options: ProgramOptions) {
    // Keep track of which node names are referenced/used
    const referenced: Set<string> = new Set();

    for (const nodeGroup of grammar.nodeGroups) {
        for (const ref of nodeGroup.members) {
            const memberName = getBareRef(ref);
            referenced.add(memberName);
            invariant(
                get(grammar.nodesByName, memberName) ||
                    (nodeGroup.name !== memberName &&
                        !!get(grammar.nodeGroupsByName, memberName)),
                `Member "${memberName}" of group "${nodeGroup.name}" is not defined in the grammar`
            );
        }
    }

    for (const node of grammar.nodes) {
        for (const field of node.fields) {
            invariant(
                !field.name.startsWith('_'),
                `Illegal field name: "${node.name}.${field.name}" (fields starting with "_" are reserved)`
            );

            if (field.ref.ref === 'Constant') {
                continue;
            } else {
                const bare = getBareRef(field.ref);
                referenced.add(bare);
                invariant(
                    options.isBuiltIn(bare) ||
                        !!grammar.nodeGroupsByName[bare] ||
                        !!get(grammar.nodesByName, bare),
                    `Unknown node kind "${bare}" (in "${node.name}.${field.name}")`
                );
            }
        }
    }

    // Check that all defined nodes are referenced
    const defined = new Set(grammar.nodes.map((n) => n.name));
    for (const name of referenced) {
        defined.delete(name);
    }

    // "Module" is the top-level node kind, which by definition won't be referenced
    defined.delete('Module');
    invariant(
        defined.size === 0,
        `The following node kinds are never referenced: ${Array.from(defined).join(', ')}`
    );
}

function generateTypeCheckCondition(
    grammar: Grammar,
    expected: NodeRef,
    actualValue: string,
    options: ProgramOptions
): string | null {
    let conditions = [];

    if (expected.ref === 'Optional') {
        const baseCondition = generateTypeCheckCondition(
            grammar,
            expected.of,
            actualValue,
            options
        );
        if (!baseCondition) {
            return null;
        }

        conditions.push(
            [`${actualValue} === null`, baseCondition]
                .filter(Boolean)
                .map((s) => `(${s})`)
                .join(' || ')
        );
    } else if (expected.ref === 'List') {
        conditions.push(`Array.isArray(${actualValue})`);
        if (expected.min > 0) {
            conditions.push(`${actualValue}.length > 0`);
        }
        const baseCondition = generateTypeCheckCondition(
            grammar,
            expected.of,
            'item',
            options
        );
        if (baseCondition) {
            conditions.push(`${actualValue}.every(item => ${baseCondition})`);
        }
    } else if (expected.ref === 'NodeGroup') {
        conditions.push(`is${expected.name}(${actualValue})`);
    } else if (TYPEOF_CHECKS.has(expected.name)) {
        conditions.push(`typeof ${actualValue} === ${JSON.stringify(expected.name)}`);
    } else if (!options.isBuiltIn(expected.name)) {
        conditions.push(
            `${actualValue}.${options.discriminator} === ${JSON.stringify(expected.name)}`
        );
    } else {
        return null;
    }

    return conditions.map((c) => `(${c})`).join(' && ') || null;
}

function splitOffPreamble(src: string): [string | null, string] {
    const lines = src.split('\n');

    // Check if this file has a preamble
    if (lines[0].trim() === '"""') {
        lines.shift();
        let preamble = '';

        do {
            const line = lines.shift();
            if (line === undefined) {
                // This is no good. We reached the end of the input. The preamble isn't
                // closed correctly.
                throw new Error('Preamble not closed correctly');
            }

            if (line.trim() === '"""') {
                // End of preamble found
                break;
            }

            preamble += line + '\n';
        } while (
            // eslint-disable-next-line no-constant-condition
            true
        );

        const rest = lines.join('\n');
        return [preamble, rest];
    }

    return [null, src];
}

function parseGrammarDefinition(inputFile: string): Grammar {
    const fullSrc = fs.readFileSync(inputFile, 'utf-8');

    const [preamble, src] = splitOffPreamble(fullSrc);

    const lines = src
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

    const nodeGroupsByName: LUT<NodeGroup> = {};
    const nodesByName: LUT<Node> = {};

    let currGroup: Array<NodeRef> | void;
    let currNode: LUT<Field> | void;

    for (let line of lines) {
        if (line.endsWith(':')) {
            line = line.substr(0, line.length - 1).trim();

            // NodeGroup or Node?
            if (line.startsWith('@')) {
                currGroup = [];
                currNode = undefined;
                nodeGroupsByName[line.substr(1)] = {
                    name: line.substr(1),
                    members: currGroup,
                };
            } else {
                currNode = {};
                currGroup = undefined;

                nodesByName[line] = {
                    name: line,
                    fieldsByName: currNode,
                    fields: [], // Will be populated in a later pass
                };
            }
            continue;
        }

        if (line.startsWith('|')) {
            const group = line.substr(1).trim();
            invariant(currGroup, 'Expect a curr node group');
            currGroup.push(parseBaseNodeRef(group));
        } else {
            const [name, spec] = line.split(/\s+/);
            invariant(currNode, 'Expect a curr node');
            currNode[name] = { name, ref: parseSpec(spec) };
        }
    }

    // Populate all the fields, for easier looping later
    for (const nodeKey of Object.keys(nodesByName)) {
        const node = nodesByName[nodeKey];
        node.fields = Object.keys(node.fieldsByName).map(
            (fieldKey) => node.fieldsByName[fieldKey]
        );
    }

    return {
        preamble,

        nodesByName,
        nodes: Object.keys(nodesByName)
            .sort()
            .map((name) => nodesByName[name]),

        nodeGroupsByName,
        nodeGroups: Object.keys(nodeGroupsByName)
            .sort()
            .map((name) => nodeGroupsByName[name]),
    };
}

function generateCode(grammar: Grammar, options: ProgramOptions): string {
    // Will throw in case of errors
    validate(grammar, options);

    const { discriminator } = options;

    const output = [
        '// @flow strict',
        '',
        '/**',
        ' * This file is AUTOMATICALLY GENERATED.',
        ' * DO NOT edit this file manually.',
        ' *',
        ' * Instead, update the `*.grammar` file, and re-run `generate-ast`',
        ' */',
        '',
        grammar.preamble,
        'import invariant from "invariant"',
        '',
    ].filter((x) => x !== null && x !== undefined);

    for (const nodeGroup of grammar.nodeGroups) {
        const [subNodes, subGroups] = partition(
            nodeGroup.members,
            (ref) => getBareRefTarget(ref) === 'Node'
        );
        const conditions = subNodes
            .map((ref) => `node.${discriminator} === ${JSON.stringify(getBareRef(ref))}`)
            .concat(subGroups.map((ref) => `is${getBareRef(ref)}(node)`));
        output.push(`
          function is${nodeGroup.name}(node: Node): boolean %checks {
            return (
              ${conditions.join(' || ')}
            )
          }
        `);
    }

    for (const nodeGroup of grammar.nodeGroups) {
        output.push(`
            export type ${nodeGroup.name} =
                ${nodeGroup.members.map((member) => `${getBareRef(member)}`).join(' | ')};
            `);
    }

    output.push(`
        export type Node = ${grammar.nodes.map((node) => node.name).join(' | ')}

        function isNode(node: Node): boolean %checks {
            return (
                ${grammar.nodes
                    .map(
                        (node) => `node.${discriminator} === ${JSON.stringify(node.name)}`
                    )
                    .join(' || ')}
            )
        }
    `);

    for (const node of grammar.nodes) {
        output.push(`
            export type ${node.name} = {|
                ${discriminator}: ${JSON.stringify(node.name)},
                ${node.fields
                    .map((field) => `${field.name}: ${getTypeScriptType(field.ref)}`)
                    .join(', ')}
            |}
        `);
    }

    output.push('');
    output.push('export default {');
    for (const node of grammar.nodes) {
        const optionals = new Set(
            takeWhile(
                node.fields.slice().reverse(),
                (field) =>
                    field.ref.ref === 'Optional' ||
                    (field.ref.ref === 'List' && field.ref.min === 0)
            ).map((field) => field.name)
        );

        const argChecks = node.fields
            .map((field) => {
                const { ref } = field;
                if (ref.ref === 'Constant') {
                    return null;
                }

                const condition = generateTypeCheckCondition(
                    grammar,
                    ref,
                    field.name,
                    options
                );
                if (!condition) {
                    return null;
                }
                return `invariant(${condition}, \`Invalid value for "${
                    field.name
                }" arg in "${node.name}" call.\\nExpected: ${serializeRef(
                    ref
                )}\\nGot:      \${JSON.stringify(${field.name})}\`)\n`;
            })
            .filter(Boolean);

        output.push(
            `
            ${node.name}(${[
                ...node.fields
                    .map((field) => {
                        let key = field.name;
                        if (field.ref.ref === 'Constant') {
                            return null;
                        }
                        const type = getTypeScriptType(field.ref);
                        return optionals.has(field.name)
                            ? `${key}: ${type} = ${
                                  field.ref.ref === 'Optional' ? 'null' : '[]'
                              }`
                            : `${key}: ${type}`;
                    })
                    .filter(Boolean),
            ].join(', ')}): ${node.name} {
                ${argChecks.join('\n')}
                return {
                    ${discriminator}: ${JSON.stringify(node.name)},
                    ${node.fields
                        .map((field) => {
                            const { ref } = field;
                            if (ref.ref === 'Constant') {
                                return `${field.name}: ${JSON.stringify(ref.value)}`;
                            } else {
                                return field.name;
                            }
                        })
                        .join(', ')}
                }
            },
            `
        );
    }

    output.push('');
    output.push('// Node groups');
    output.push('isNode,');
    for (const nodeGroup of grammar.nodeGroups) {
        output.push(`is${nodeGroup.name},`);
    }
    output.push('}');

    return prettier.format(output.join('\n'), PRETTIER_OPTIONS);
}

function writeFile(contents: string, path: string) {
    const existing = fs.existsSync(path)
        ? fs.readFileSync(path, { encoding: 'utf-8' })
        : null;
    if (contents !== existing) {
        fs.writeFileSync(path, contents, { encoding: 'utf-8' });
        console.error(`Wrote ${path}`);
    } else {
        // Output file is still up to date, let's not write (since it may
        // trigger another watch proc)
    }
}

function runWithOptions(options: ProgramOptions): void {
    const grammar = parseGrammarDefinition(options.inputFile);
    const code = generateCode(grammar, options);
    writeFile(code, options.outputFile);
}

function run() {
    function collect(val, memo) {
        memo.push(val);
        return memo;
    }

    const program = commander
        // $FlowFixMe[incompatible-call] - ugh commander
        .name('generate-ast')
        .usage('[options] <input> [<output>]')
        .description(
            'Generates a TypeScript or JavaScript module from an AST specification.'
        )
        .option('--discriminator <identifier>', 'Field name to use as discriminator')
        .option('--builtin <name>', 'Identifier to treat as a built-in', collect, [])
        .option('-v, --verbose', 'Be verbose')
        .parse(process.argv);

    if (program.args.length < 1) {
        program.help();
    } else {
        const opts = program.opts();
        const inputFile = program.args[0];
        const outputFile =
            program.args[1] || program.args[0].replace(/.grammar$/, '') + '.js';

        const builtIns = new Set([...DEFAULT_BUILTINS, ...opts.builtin]);

        // eslint-disable-next-line no-inner-declarations
        function isBuiltIn(name: string): boolean {
            return builtIns.has(name);
        }

        const options: ProgramOptions = {
            inputFile,
            outputFile,
            discriminator: opts.discriminator ?? '_kind',
            isBuiltIn,
            verbose: !!opts.verbose,
        };

        runWithOptions(options);
    }
}

try {
    run();
} catch (e) {
    console.error(chalk.red(`Error: ${e.message}`));
    process.exit(2);
}
