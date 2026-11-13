// The renderer's setup exit: what the page needs before the renderer's other modules load, since
// they read it as they load: the settings (parsed from the address and installed), the look
// (installed, or the renderer's neutral one) and its tables' types, the quality tiers and the
// render scale a tier sets. The page's first module (PageSettings.ts) installs the settings and
// the look through it, so none of the modules it loads reads the look (tools/verify-layers.mjs,
// its look check). Every file it loads imports relative paths only, and it loads in plain node,
// where the headless game reads the settings through it (tools/verify-exits.mjs). A name is in one
// exit only: these are not in render/index.ts.
export { ACTIVE_QUALITY, DEFAULT_QUALITY, QUALITY, QUALITY_TIERS, isQualityTier, qualityProfile } from './Quality.ts';
export type { QualityProfile, QualityTier } from './Quality.ts';
export { installSettings, numberSetting, parseSettings, settingProblems, settings } from './Settings.ts';
export type { SettingName, SettingsQuery } from './Settings.ts';
export { installLook } from './look/Look.ts';
export type { AmbientLook, AmbientRowLook, BloomKey, DayLook, DesaturationKey, DisplayLook, ExposureKey, ExposureLook, FullKey, HazeLook, IslandSkyRow, LocalLightsLook, Look, MeadowCanopyLook, OcclusionLook, Rgb, SeaLook, SharingKey, SkyLook, WindLook } from './look/Look.ts';
export { NEUTRAL_LOOK } from './look/NeutralLook.ts';
export { dynamicRange, outputPixelRatio, renderPixelRatio } from './post/RenderScale.ts';
