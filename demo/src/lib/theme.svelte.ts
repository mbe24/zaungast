// Theme registry + switcher. Each theme is a full token set defined in src/routes/layout.css under
// [data-theme='<id>']; dark themes also toggle the `.dark` class so component `dark:` variants apply.
// Add a theme = add an entry here + a matching [data-theme] block in layout.css.

export type ThemeId = 'latte' | 'frappe' | 'nord';

export interface ThemeDef {
	id: ThemeId;
	name: string;
	dark: boolean;
}

export const themes: ThemeDef[] = [
	{ id: 'latte', name: 'Catppuccin Latte', dark: false },
	{ id: 'frappe', name: 'Catppuccin Frappé', dark: true },
	{ id: 'nord', name: 'Nord', dark: true },
];

const STORAGE_KEY = 'zaungast-theme';
const DEFAULT: ThemeId = 'frappe';

function initial(): ThemeId {
	if (typeof localStorage !== 'undefined') {
		const v = localStorage.getItem(STORAGE_KEY);
		if (v && themes.some((t) => t.id === v)) return v as ThemeId;
	}
	return DEFAULT;
}

export const theme = $state<{ id: ThemeId }>({ id: initial() });

export function setTheme(id: ThemeId): void {
	theme.id = id;
	const def = themes.find((t) => t.id === id) ?? themes[0];
	const root = document.documentElement;
	root.setAttribute('data-theme', def.id);
	root.classList.toggle('dark', def.dark);
	try {
		localStorage.setItem(STORAGE_KEY, def.id);
	} catch {
		/* localStorage unavailable — ignore */
	}
}
