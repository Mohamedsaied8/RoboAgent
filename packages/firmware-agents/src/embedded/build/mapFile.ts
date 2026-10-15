/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  GNU ld map file (`-Wl,-Map=app.map`) parser. Reads the "Memory Configuration" table and the
 *  output sections of "Linker script and memory map", attributing input sections to the object
 *  files (and archive members) that contributed them.
 *--------------------------------------------------------------------------------------------*/

export interface MemoryRegion {
	readonly name: string;
	readonly origin: number;
	readonly length: number;
	/** Bytes placed in this region: sections that run there plus load images stored there. */
	readonly used: number;
}

export interface OutputSection {
	readonly name: string;
	readonly address: number;
	readonly size: number;
	/** Load address when it differs from the run address (e.g. `.data` initialisers in flash). */
	readonly loadAddress?: number;
	/** Region the section's address falls in. */
	readonly region?: string;
	/** Region holding the load image, when that is a different region. */
	readonly loadRegion?: string;
}

export interface Contributor {
	/** Object file, or `libfoo.a(bar.o)` for an archive member. */
	readonly object: string;
	readonly bytes: number;
	/** Bytes per output section, e.g. `{ ".text": 312, ".bss": 1024 }`. */
	readonly sections: Readonly<Record<string, number>>;
}

export interface MapReport {
	readonly regions: readonly MemoryRegion[];
	readonly sections: readonly OutputSection[];
	/** Largest contributors first. */
	readonly contributors: readonly Contributor[];
}

const hex = (s: string) => parseInt(s, 16);

/** Zero-initialised / reserved sections: ld prints a load address for them, but nothing is stored there. */
function hasNoLoadImage(name: string): boolean {
	return /^\.(bss|sbss|tbss|noinit|heap|stack|_user_heap_stack)\b/.test(name);
}

/** Sections that occupy target memory (debug info and the like do not). */
function isAllocated(name: string): boolean {
	return !/^\.(debug|comment|ARM\.attributes|stab|note|gnu\.attributes)/.test(name) && name !== '/DISCARD/';
}

export function parseMapFile(text: string, topContributors = 25): MapReport {
	const lines = text.split(/\r?\n/);
	const regions: { name: string; origin: number; length: number }[] = [];
	const sections: OutputSection[] = [];
	const perObject = new Map<string, Map<string, number>>();

	let i = lines.findIndex(l => l.startsWith('Memory Configuration'));
	if (i >= 0) {
		for (i++; i < lines.length && !lines[i].startsWith('Linker script and memory map'); i++) {
			const m = /^(\S+)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)/i.exec(lines[i]);
			if (m && m[1] !== '*default*' && m[1] !== 'Name') {
				regions.push({ name: m[1], origin: hex(m[2]), length: hex(m[3]) });
			}
		}
	}
	const start = lines.findIndex(l => l.startsWith('Linker script and memory map'));
	let current: string | undefined;
	let pendingInput: string | undefined;

	for (let j = Math.max(start, 0); j < lines.length; j++) {
		const line = lines[j];
		// Output section: starts in column 0 with a name; address and size may wrap to the next line.
		let m = /^(\.[\w.]+|[A-Za-z_][\w.]*)(?:\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)(?:\s+load address 0x([0-9a-f]+))?)?\s*$/i.exec(line);
		if (m && !line.startsWith(' ') && m[1] !== 'LOAD' && m[1] !== 'OUTPUT') {
			let address = m[2], size = m[3], load = m[4];
			if (!address) {
				const next = /^\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)(?:\s+load address 0x([0-9a-f]+))?/i.exec(lines[j + 1] ?? '');
				if (next) {
					[, address, size, load] = next;
					j++;
				}
			}
			current = m[1];
			if (address && isAllocated(current)) {
				const loadAddress = load ? hex(load) : undefined;
				const stored = loadAddress !== undefined && loadAddress !== hex(address) && !hasNoLoadImage(current);
				sections.push({ name: current, address: hex(address), size: hex(size!), ...stored ? { loadAddress } : {} });
			}
			continue;
		}
		if (!current || !isAllocated(current)) {
			continue;
		}
		// Input section: " .text.main  0x08000100  0x24 build/main.o" (may wrap after a long name).
		m = /^ (\.[\w.$]+|COMMON)\s*$/.exec(line);
		if (m) {
			pendingInput = m[1];
			continue;
		}
		m = pendingInput
			? /^\s+()0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S.*)$/i.exec(line)
			: /^ (\.[\w.$]+|COMMON)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S.*)$/i.exec(line);
		if (m) {
			pendingInput = undefined;
			const size = hex(m[3]);
			const object = m[4].trim();
			if (size > 0 && !object.startsWith('load address')) {
				const bySection = perObject.get(object) ?? new Map<string, number>();
				bySection.set(current, (bySection.get(current) ?? 0) + size);
				perObject.set(object, bySection);
			}
		} else {
			pendingInput = undefined;
		}
	}

	const regionOf = (address: number) => regions.find(r => address >= r.origin && address < r.origin + r.length)?.name;
	const withRegion = sections.map(s => {
		const region = regionOf(s.address);
		const loadRegion = s.loadAddress !== undefined ? regionOf(s.loadAddress) : undefined;
		return { ...s, ...region ? { region } : {}, ...loadRegion && loadRegion !== region ? { loadRegion } : {} };
	});
	const usedIn = (name: string) => withRegion.reduce((sum, s) => sum + (s.region === name ? s.size : 0) + (s.loadRegion === name ? s.size : 0), 0);
	return {
		regions: regions.map(r => ({ ...r, used: usedIn(r.name) })),
		sections: withRegion.filter(s => s.size > 0),
		contributors: [...perObject.entries()]
			.map(([object, map]) => ({ object, bytes: [...map.values()].reduce((a, b) => a + b, 0), sections: Object.fromEntries(map) }))
			.sort((a, b) => b.bytes - a.bytes)
			.slice(0, topContributors),
	};
}
