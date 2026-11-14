// The render pipeline's setup exit: the settings, quality tiers and look types loaded before the rest.
//
// The render pipeline's setup exit: what the page needs before the render pipeline's other modules
// load, since they read it as they load: the settings (parsed from the address and installed), the
// quality tiers and the render scale a tier sets; and the look's types and the render pipeline's
// neutral set, which the page picks from and hands to the render pipeline's stages. The page's
// first module (PageSettings.ts) installs the settings through it. Every file it loads imports
// relative paths only, and it loads in plain node, where the headless game reads the settings
// through it (tools/repo/verify-exits.mjs). A name is in one exit only: these are not in
// render/index.ts.
export { ACTIVE_QUALITY, DEFAULT_QUALITY, QUALITY, QUALITY_TIERS, isQualityTier } from './Quality.ts';
export type { QualityTier } from './Quality.ts';
export { installSettings, mergeSettings, numberSetting, parseSettings, RENDER_SETTINGS, settingProblems, settingsFor } from './Settings.ts';
export type { SettingName, SettingsQuery, SettingsTable } from './Settings.ts';
export type { AmbientLook, AmbientRowLook, BloomKey, DayLook, DesaturationKey, DisplayLook, ExposureKey, ExposureLook, FullKey, HazeLook, LandSkyRow, LocalLightsLook, Look, MeadowCanopyLook, OcclusionLook, Rgb, SeaLook, SharingKey, SkyLook, WindLook } from './look/Look.ts';
export { NEUTRAL_LOOK } from './look/NeutralLook.ts';
export { renderPixelRatio } from './post/RenderScale.ts';
