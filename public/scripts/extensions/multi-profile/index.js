import { eventSource, event_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { registerFeatureProfileResolver } from '../../connection-context.js';

const MODULE_NAME = 'multiProfile';
const NONE = '';

/**
 * Feature ids consumed by the four call sites.
 * Keep in sync with the keys passed to `getFeatureProfile()` in core / extensions.
 */
const FEATURES = [
    { id: 'memory',      elementId: 'multi_profile_memory' },
    { id: 'expressions', elementId: 'multi_profile_expressions' },
    { id: 'sd',          elementId: 'multi_profile_sd' },
];

const DEFAULT_SETTINGS = {
    /** @type {Record<string, string>}  feature id -> profile id ('' means inherit) */
    assignments: {},
};

function getAssignments() {
    return extension_settings[MODULE_NAME]?.assignments ?? {};
}

function getProfiles() {
    return extension_settings.connectionManager?.profiles ?? [];
}

function renderSelect(selectEl, currentValue) {
    selectEl.innerHTML = '';

    const noneOption = document.createElement('option');
    noneOption.value = NONE;
    noneOption.textContent = '— inherit global —';
    selectEl.appendChild(noneOption);

    const profiles = [...getProfiles()].sort((a, b) => a.name.localeCompare(b.name));
    for (const profile of profiles) {
        const opt = document.createElement('option');
        opt.value = profile.id;
        opt.textContent = profile.name;
        selectEl.appendChild(opt);
    }

    selectEl.value = currentValue && profiles.some(p => p.id === currentValue) ? currentValue : NONE;
}

function refreshAllSelects() {
    const assignments = getAssignments();
    for (const feature of FEATURES) {
        const el = /** @type {HTMLSelectElement} */ (document.getElementById(feature.elementId));
        if (el) {
            renderSelect(el, assignments[feature.id]);
        }
    }
}

jQuery(async function () {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || structuredClone(DEFAULT_SETTINGS);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }

    registerFeatureProfileResolver((featureId) => {
        const assignments = getAssignments();
        return assignments[featureId] || null;
    });

    const settingsHtml = await renderExtensionTemplateAsync('multi-profile', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    refreshAllSelects();

    for (const feature of FEATURES) {
        const el = /** @type {HTMLSelectElement|null} */ (document.getElementById(feature.elementId));
        if (!el) continue;
        el.addEventListener('change', () => {
            const assignments = extension_settings[MODULE_NAME].assignments ?? (extension_settings[MODULE_NAME].assignments = {});
            assignments[feature.id] = el.value || '';
            saveSettingsDebounced();
        });
    }

    // Re-render dropdowns when profiles are added / removed / renamed so the user always sees
    // the current profile list.
    const refreshOn = [
        event_types.CONNECTION_PROFILE_LOADED,
        event_types.CONNECTION_PROFILE_CREATED,
        event_types.CONNECTION_PROFILE_DELETED,
        event_types.CONNECTION_PROFILE_UPDATED,
    ];
    for (const evt of refreshOn) {
        if (evt) eventSource.on(evt, refreshAllSelects);
    }
});
