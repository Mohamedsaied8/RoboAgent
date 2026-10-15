/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** One XML element: attributes, child elements and its own text (trimmed). */
export interface XmlElement {
	readonly name: string;
	readonly attributes: Readonly<Record<string, string>>;
	readonly children: XmlElement[];
	text: string;
}

export class XmlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'XmlError';
	}
}

const MAX_DEPTH = 64;
const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' };

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,4});/g, (whole, entity: string) => {
		if (entity.startsWith('#')) {
			const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
			return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[entity] ?? whole;
	});
}

/**
 * A small, linear-time XML reader for data files such as CMSIS-SVD. Supports elements,
 * attributes, text, comments, CDATA and the five predefined entities. No DTDs, no external
 * entities (so no entity-expansion or XXE attacks), nesting capped at 64.
 */
export function parseXml(source: string): XmlElement {
	let i = 0;
	const n = source.length;
	const stack: XmlElement[] = [];
	let root: XmlElement | undefined;
	const textParts: string[][] = [];

	const fail = (message: string): never => {
		throw new XmlError(`${message} at offset ${i}`);
	};

	while (i < n) {
		const lt = source.indexOf('<', i);
		const textEnd = lt === -1 ? n : lt;
		if (textEnd > i && stack.length) {
			textParts[stack.length - 1].push(decodeEntities(source.slice(i, textEnd)));
		}
		if (lt === -1) {
			break;
		}
		i = lt;
		if (source.startsWith('<!--', i)) {
			const end = source.indexOf('-->', i + 4);
			i = end === -1 ? fail('unterminated comment') : end + 3;
		} else if (source.startsWith('<![CDATA[', i)) {
			const end = source.indexOf(']]>', i + 9);
			if (end === -1) {
				fail('unterminated CDATA');
			}
			if (stack.length) {
				textParts[stack.length - 1].push(source.slice(i + 9, end));
			}
			i = end + 3;
		} else if (source.startsWith('<?', i)) {
			const end = source.indexOf('?>', i + 2);
			i = end === -1 ? fail('unterminated processing instruction') : end + 2;
		} else if (source.startsWith('<!', i)) {
			fail('DTDs and declarations are not supported');
		} else if (source.startsWith('</', i)) {
			const end = source.indexOf('>', i + 2);
			if (end === -1) {
				fail('unterminated end tag');
			}
			const name = source.slice(i + 2, end).trim();
			const open = stack.pop();
			if (!open || open.name !== name) {
				fail(`unexpected </${name}>`);
			}
			open!.text = textParts.pop()!.join('').trim();
			i = end + 1;
		} else {
			const tag = /^<([A-Za-z_][\w.:-]*)/.exec(source.slice(i, i + 256));
			if (!tag) {
				fail('invalid tag');
			}
			i += tag![0].length;
			const attributes: Record<string, string> = Object.create(null);
			for (; ;) {
				while (i < n && /\s/.test(source[i])) {
					i++;
				}
				if (source.startsWith('/>', i) || source[i] === '>') {
					break;
				}
				const attr = /^([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(source.slice(i, i + 4096));
				if (!attr) {
					fail('invalid attribute');
				}
				attributes[attr![1]] = decodeEntities(attr![2] ?? attr![3]);
				i += attr![0].length;
			}
			const element: XmlElement = { name: tag![1], attributes, children: [], text: '' };
			if (stack.length) {
				stack[stack.length - 1].children.push(element);
			} else if (root) {
				fail('more than one root element');
			} else {
				root = element;
			}
			if (source[i] === '>') {
				if (stack.length >= MAX_DEPTH) {
					fail('nesting too deep');
				}
				stack.push(element);
				textParts.push([]);
				i += 1;
			} else {
				i += 2;
			}
		}
	}
	if (stack.length || !root) {
		throw new XmlError(stack.length ? `unclosed <${stack[stack.length - 1].name}>` : 'no root element');
	}
	return root;
}

/** First child element called `name`. */
export function child(element: XmlElement, name: string): XmlElement | undefined {
	return element.children.find(c => c.name === name);
}

/** Text of the first child element called `name`. */
export function childText(element: XmlElement, name: string): string | undefined {
	return child(element, name)?.text;
}
