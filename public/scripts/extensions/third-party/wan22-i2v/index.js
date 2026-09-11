// Wan2.2 Image-to-Video — SillyTavern client extension
//
// Adds a video-generate button on top of any chat message that carries an
// SD-generated image. Clicking it fetches the currently-displayed image,
// hands it to the local plugin backend (which talks to ComfyUI), then
// appends the returned video as a new item in message.extra.media[].
// SillyTavern's built-in gallery-swipe UI (chats.js:onImageSwiped) picks up
// the additional item automatically — no core-script changes needed.

import { chat, saveSettingsDebounced, saveChatConditional, eventSource, event_types, getRequestHeaders, appendMediaToMessage } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveBase64AsFile } from '../../../utils.js';
import { MEDIA_SOURCE, MEDIA_TYPE, SCROLL_BEHAVIOR } from '../../../constants.js';
import { t } from '../../../i18n.js';

const EXTENSION_ID = 'wan22-i2v';
const PLUGIN_BASE = '/api/plugins/wan22-i2v';

const DEFAULTS = Object.freeze({
    comfy_url: 'http://192.168.81.252:8188',
    max_edge: 768,
    steps: 20,
    cfg: 4.5,
    length: 45,
    fps: 24,
    prompt: 'Build a sexy, playful animation based on the input picture provided',
    negative_prompt: '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走',
    workflow: '',
    button_visible: true,
});

function getSettings() {
    if (!extension_settings[EXTENSION_ID]) {
        extension_settings[EXTENSION_ID] = { ...DEFAULTS };
    }
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (extension_settings[EXTENSION_ID][k] === undefined) {
            extension_settings[EXTENSION_ID][k] = v;
        }
    }
    return extension_settings[EXTENSION_ID];
}

async function initSettingsPanel() {
    const html = await renderExtensionTemplateAsync('third-party/wan22-i2v', 'settings');
    $('#extensions_settings2').append(html);

    const s = getSettings();
    const bind = (selector, key, transform = v => v) => {
        const $el = $(selector);
        $el.val(s[key]);
        $el.on('input change', () => {
            s[key] = transform($el.val());
            saveSettingsDebounced();
        });
    };

    bind('#wan22_i2v_comfy_url', 'comfy_url');
    bind('#wan22_i2v_max_edge', 'max_edge', v => Number(v) || DEFAULTS.max_edge);
    bind('#wan22_i2v_steps', 'steps', v => Number(v) || DEFAULTS.steps);
    bind('#wan22_i2v_cfg', 'cfg', v => Number(v) || DEFAULTS.cfg);
    bind('#wan22_i2v_length', 'length', v => Number(v) || DEFAULTS.length);
    bind('#wan22_i2v_fps', 'fps', v => Number(v) || DEFAULTS.fps);
    bind('#wan22_i2v_prompt', 'prompt');
    bind('#wan22_i2v_negative_prompt', 'negative_prompt');
    bind('#wan22_i2v_workflow', 'workflow');

    const $btnVisible = $('#wan22_i2v_button_visible');
    $btnVisible.prop('checked', !!s.button_visible);
    $btnVisible.on('change', () => {
        s.button_visible = $btnVisible.prop('checked');
        saveSettingsDebounced();
        $('body').toggleClass('wan22-i2v-buttons-hidden', !s.button_visible);
    });
    $('body').toggleClass('wan22-i2v-buttons-hidden', !s.button_visible);

    $('#wan22_i2v_ping').on('click', async () => {
        try {
            const r = await fetch(`${PLUGIN_BASE}/ping`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ url: s.comfy_url }),
            });
            if (r.ok) toastr.success(t`ComfyUI reachable at ${s.comfy_url}`);
            else toastr.error(t`ComfyUI ping failed (HTTP ${r.status})`);
        } catch (e) {
            toastr.error(t`ComfyUI ping error: ${e.message}`);
        }
    });
}

/**
 * Given the DOM node of a chat message, return the mesid it represents.
 * @param {HTMLElement} mesEl
 * @returns {number|null}
 */
function mesIdFromElement(mesEl) {
    const id = mesEl?.getAttribute?.('mesid');
    return id == null ? null : Number(id);
}

function currentDisplayedImageUrl(message) {
    const media = message?.extra?.media;
    if (!Array.isArray(media) || !media.length) return null;
    const idx = clamp(Number(message.extra.media_index ?? 0), 0, media.length - 1);
    const item = media[idx];
    if (item?.type && item.type !== MEDIA_TYPE.IMAGE) {
        // Currently-focused item is not an image; find the last image in the list.
        for (let i = media.length - 1; i >= 0; i--) {
            if (media[i]?.type === MEDIA_TYPE.IMAGE || !media[i]?.type) return { url: media[i].url, index: i };
        }
        return null;
    }
    return { url: item?.url ?? null, index: idx };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Fetch a same-origin image URL and return it as a raw base64 payload (no data: prefix).
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchAsBase64(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url} failed: HTTP ${res.status}`);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
            const s = String(fr.result || '');
            const comma = s.indexOf(',');
            resolve(comma >= 0 ? s.slice(comma + 1) : s);
        };
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
    });
}

async function generateVideoForMessage(messageId) {
    const message = chat[messageId];
    if (!message) return;
    const shot = currentDisplayedImageUrl(message);
    if (!shot?.url) {
        toastr.warning(t`No image found on this message.`);
        return;
    }

    const s = getSettings();
    const toast = toastr.info(
        t`Generating video from image… this can take a couple of minutes.`,
        t`Wan2.2 i2v`,
        { timeOut: 0, extendedTimeOut: 0, closeButton: false });

    try {
        const base64 = await fetchAsBase64(shot.url);
        const body = {
            url: s.comfy_url,
            image: base64,
            max_edge: s.max_edge,
            steps: s.steps,
            cfg: s.cfg,
            length: s.length,
            fps: s.fps,
            prompt: s.prompt,
            negative_prompt: s.negative_prompt,
        };
        if (s.workflow && s.workflow.trim().length) {
            try {
                body.workflow = JSON.parse(s.workflow);
            } catch (e) {
                throw new Error(t`Custom workflow is not valid JSON: ${e.message}`);
            }
        }

        const res = await fetch(`${PLUGIN_BASE}/generate`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(t`Server returned ${res.status}: ${text.slice(0, 300)}`);
        }
        const data = await res.json();
        if (!data?.data || !data?.format) throw new Error(t`Malformed plugin response`);

        // Persist the video into the character's images folder like SD does.
        const charName = message.name || 'character';
        const filename = `wan22_i2v_${Date.now()}`;
        const path = await saveBase64AsFile(data.data, charName, filename, data.format);

        // Append to the message's media list.
        if (!Array.isArray(message.extra.media)) message.extra.media = [];
        message.extra.media.push({
            url: path,
            type: MEDIA_TYPE.VIDEO,
            title: t`Wan2.2 i2v (from image #${shot.index + 1})`,
            source: MEDIA_SOURCE.GENERATED,
            generation_type: 'wan22-i2v',
        });
        message.extra.media_index = message.extra.media.length - 1;
        // Focus displayed variant on the new item.
        await saveChatConditional();
        const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
        if (messageBlock.length) appendMediaToMessage(message, messageBlock, SCROLL_BEHAVIOR.KEEP);
        toastr.success(t`Video ready.`);
    } catch (e) {
        console.error('[wan22-i2v] generate error', e);
        toastr.error(String(e.message ?? e));
    } finally {
        if (toast) toastr.clear(toast);
    }
}

/**
 * Inject the video button into any message that carries at least one image
 * media entry. Idempotent — safe to call from repeated MESSAGE_UPDATED events.
 * @param {HTMLElement|JQuery<HTMLElement>} mesEl
 */
function decorateMessage(mesEl) {
    const el = mesEl instanceof Element ? mesEl : mesEl?.get?.(0);
    if (!el) return;
    const messageId = mesIdFromElement(el);
    if (messageId == null || Number.isNaN(messageId)) return;
    const message = chat[messageId];
    if (!message?.extra?.media?.length) return;
    // Only for messages that contain at least one image
    const hasImage = message.extra.media.some(m => !m?.type || m.type === MEDIA_TYPE.IMAGE);
    if (!hasImage) return;

    const container = el.querySelector('.mes_img_container') || el.querySelector('.mes_block');
    if (!container) return;
    if (container.querySelector('.wan22-i2v-btn')) return; // already decorated

    const btn = document.createElement('div');
    btn.className = 'wan22-i2v-btn mes_button interactable';
    btn.title = t`Generate video from image (Wan2.2)`;
    btn.innerHTML = '<i class="fa-solid fa-film"></i>';
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        await generateVideoForMessage(messageId);
    });
    container.appendChild(btn);
}

function decorateAll() {
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        decorateMessage(el);
    }
}

async function initExtension() {
    getSettings();
    await initSettingsPanel();

    // React to messages being rendered/updated/appended.
    const relevant = [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_RECEIVED,
        event_types.CHAT_CHANGED,
    ];
    for (const t of relevant) {
        eventSource.on(t, () => setTimeout(decorateAll, 0));
    }
    setTimeout(decorateAll, 500);
    console.log('[wan22-i2v] extension loaded');
}

// SillyTavern loads third-party extensions via jQuery(async ...) IIFE.
jQuery(async () => {
    try {
        await initExtension();
    } catch (e) {
        console.error('[wan22-i2v] init failed', e);
    }
});
