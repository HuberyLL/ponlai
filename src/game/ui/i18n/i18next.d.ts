import 'i18next';
import type zh from './zh-CN.json';

// The catalogue's keys for the type check: `t` takes only keys the source (zh-CN.json) has.
declare module 'i18next' {
	interface CustomTypeOptions {
		defaultNS: 'translation';
		resources: { translation: typeof zh };
	}
}
