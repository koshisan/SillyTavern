/**
 * SillyTavern server plugin: Wan2.2 image-to-video via ComfyUI.
 *
 * Exposes:
 *   POST /api/plugins/wan22-i2v/ping        — health check against a given ComfyUI URL
 *   POST /api/plugins/wan22-i2v/generate    — upload image, run i2v workflow, return video base64
 *
 * The plugin bundles a default workflow API JSON (default_workflow.json) but
 * accepts a per-request override so users can point at any i2v-shaped workflow
 * as long as it contains a LoadImage node and a SaveVideo node.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKFLOW_PATH = path.join(__dirname, 'default_workflow.json');

const info = {
    id: 'wan22-i2v',
    name: 'Wan2.2 Image-to-Video',
    description: 'ComfyUI proxy for image-to-video generation.',
};

/**
 * @param {import('express').Router} router
 */
async function init(router) {
    router.post('/ping', async (req, res) => {
        try {
            const url = joinUrl(req.body?.url, '/system_stats');
            const r = await fetch(url);
            if (!r.ok) throw new Error(`ComfyUI ping ${r.status}`);
            res.sendStatus(200);
        } catch (e) {
            console.warn('[wan22-i2v] ping failed:', e.message);
            res.status(502).send({ error: e.message });
        }
    });

    router.post('/generate', async (req, res) => {
        try {
            const {
                url,
                image,
                workflow,
                max_edge = 768,
                prompt,
                negative_prompt,
                steps,
                cfg,
                length,
                fps,
            } = req.body || {};

            if (!url) throw new Error('missing url');
            if (!image) throw new Error('missing image (expected base64 png/jpg)');

            const workflowJson = workflow
                ? (typeof workflow === 'string' ? JSON.parse(workflow) : workflow)
                : loadDefaultWorkflow();

            // Upload image to ComfyUI input folder
            const uploaded = await uploadImage(url, image);
            const nodeIds = discoverNodeIds(workflowJson);
            if (!nodeIds.loadImage) throw new Error('workflow has no LoadImage node');
            workflowJson[nodeIds.loadImage].inputs.image = uploaded.name;

            // Random seed so consecutive gens don't repeat
            if (nodeIds.kSampler) {
                workflowJson[nodeIds.kSampler].inputs.seed = Math.floor(Math.random() * 2 ** 53);
                if (typeof steps === 'number') workflowJson[nodeIds.kSampler].inputs.steps = steps;
                if (typeof cfg === 'number') workflowJson[nodeIds.kSampler].inputs.cfg = cfg;
            }
            if (nodeIds.constrainDimensions && typeof max_edge === 'number') {
                workflowJson[nodeIds.constrainDimensions].inputs.max_edge = max_edge;
            }
            if (nodeIds.positivePrompt && typeof prompt === 'string' && prompt.length) {
                workflowJson[nodeIds.positivePrompt].inputs.text = prompt;
            }
            if (nodeIds.negativePrompt && typeof negative_prompt === 'string' && negative_prompt.length) {
                workflowJson[nodeIds.negativePrompt].inputs.text = negative_prompt;
            }
            if (nodeIds.wan22Latent && typeof length === 'number') {
                workflowJson[nodeIds.wan22Latent].inputs.length = length;
            }
            if (nodeIds.createVideo && typeof fps === 'number') {
                workflowJson[nodeIds.createVideo].inputs.fps = fps;
            }

            // Submit
            const promptUrl = joinUrl(url, '/prompt');
            const submit = await fetch(promptUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: workflowJson }),
            });
            if (!submit.ok) {
                const text = await submit.text();
                throw new Error(`prompt submit ${submit.status}: ${text.slice(0, 400)}`);
            }
            const submitJson = await submit.json();
            const promptId = submitJson?.prompt_id;
            if (!promptId) throw new Error('prompt submit returned no prompt_id');

            // Poll history until item shows up with an outputs field
            const historyUrl = joinUrl(url, `/history/${promptId}`);
            let item = null;
            const startedAt = Date.now();
            const timeoutMs = 10 * 60 * 1000; // 10 min ceiling
            while (Date.now() - startedAt < timeoutMs) {
                const hr = await fetch(historyUrl);
                if (hr.ok) {
                    const hist = await hr.json();
                    if (hist && hist[promptId]) {
                        item = hist[promptId];
                        if (item.status && (item.status.status_str === 'success' || item.status.status_str === 'error')) {
                            break;
                        }
                    }
                }
                await sleep(750);
            }
            if (!item) throw new Error('ComfyUI generation timed out');
            if (item.status?.status_str === 'error') {
                const messages = item.status.messages || [];
                const err = messages.filter(m => m[0] === 'execution_error').map(m => m[1]);
                throw new Error(`ComfyUI error: ${JSON.stringify(err).slice(0, 500)}`);
            }

            // Find the video output. ComfyUI's SaveVideo node emits under
            // outputs.<node>.images (yes, .images) with an .animated:true
            // sibling and a filename ending in .mp4/.webm. Older AnimateDiff
            // saver nodes use outputs.videos or outputs.gifs. Cover all three.
            const videoInfo = findVideoInOutputs(item.outputs || {});
            if (!videoInfo) {
                console.warn('[wan22-i2v] outputs snapshot:', JSON.stringify(item.outputs).slice(0, 1000));
                throw new Error('ComfyUI outputs did not contain a video');
            }

            const viewUrl = new URL(joinUrl(url, '/view'));
            viewUrl.search = `?filename=${encodeURIComponent(videoInfo.filename)}&subfolder=${encodeURIComponent(videoInfo.subfolder || '')}&type=${encodeURIComponent(videoInfo.type || 'output')}`;
            const videoRes = await fetch(viewUrl);
            if (!videoRes.ok) throw new Error(`fetch video ${videoRes.status}`);
            const buf = Buffer.from(await videoRes.arrayBuffer());
            const format = path.extname(videoInfo.filename).slice(1).toLowerCase() || 'mp4';

            res.send({ format, data: buf.toString('base64'), filename: videoInfo.filename });
        } catch (e) {
            console.error('[wan22-i2v] generate failed:', e);
            res.status(500).send({ error: e.message });
        }
    });
}

const VIDEO_EXTS = new Set(['mp4', 'webm', 'gif', 'mov', 'mkv']);

/**
 * Locate the produced video across the various node output shapes ComfyUI
 * uses. Returns the first hit as {filename, subfolder, type}.
 * @param {Record<string, any>} outputsMap
 */
function findVideoInOutputs(outputsMap) {
    for (const node of Object.values(outputsMap)) {
        for (const key of ['videos', 'gifs']) {
            const list = node?.[key];
            if (Array.isArray(list) && list.length) return list[0];
        }
        // New SaveVideo path — images list carrying the .mp4, animated: true.
        const images = node?.images;
        if (Array.isArray(images) && images.length) {
            const animated = node.animated === true || node.animated === 'true';
            const videoLike = images.find(img => {
                const fn = String(img?.filename ?? '');
                const ext = fn.split('.').pop().toLowerCase();
                return VIDEO_EXTS.has(ext);
            });
            if (videoLike) return videoLike;
            if (animated && images[0]) return images[0];
        }
    }
    return null;
}

/**
 * @param {string} base
 * @param {string} tail
 */
function joinUrl(base, tail) {
    if (!base) return tail;
    return base.replace(/\/+$/, '') + '/' + tail.replace(/^\/+/, '');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function loadDefaultWorkflow() {
    const raw = fs.readFileSync(DEFAULT_WORKFLOW_PATH, 'utf-8');
    return JSON.parse(raw);
}

/**
 * Locate common nodes in a Wan2.2-shaped workflow by their class_type.
 * Returns a map of role → node_id string.
 * @param {Record<string, any>} workflow
 */
function discoverNodeIds(workflow) {
    const roles = {
        loadImage: 'LoadImage',
        kSampler: 'KSampler',
        constrainDimensions: 'ConstrainDimensions',
        wan22Latent: 'Wan22ImageToVideoLatent',
        createVideo: 'CreateVideo',
    };
    /** @type {Record<string, string|null>} */
    const out = { positivePrompt: null, negativePrompt: null };
    for (const [role, cls] of Object.entries(roles)) out[role] = null;
    for (const [nid, node] of Object.entries(workflow)) {
        const t = node?.class_type;
        if (!t) continue;
        for (const [role, cls] of Object.entries(roles)) {
            if (t === cls && !out[role]) out[role] = nid;
        }
    }
    // Positive vs. negative prompt: KSampler.inputs.positive/negative point at CLIPTextEncode
    // nodes via links, which the LoadImage-style resolution doesn't cover. Read them off KSampler.
    if (out.kSampler) {
        const ks = workflow[out.kSampler].inputs || {};
        if (Array.isArray(ks.positive)) out.positivePrompt = String(ks.positive[0]);
        if (Array.isArray(ks.negative)) out.negativePrompt = String(ks.negative[0]);
    }
    return out;
}

/**
 * Upload a base64 image to ComfyUI's /upload/image endpoint.
 * @param {string} baseUrl ComfyUI base URL
 * @param {string} base64 base64-encoded png/jpg (no data: prefix)
 * @returns {Promise<{name: string, subfolder: string, type: string}>}
 */
async function uploadImage(baseUrl, base64) {
    const cleaned = base64.replace(/^data:[^,]+,/, '');
    const buf = Buffer.from(cleaned, 'base64');
    const filename = `st_i2v_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`;
    const form = new FormData();
    form.append('image', new Blob([buf], { type: 'image/png' }), filename);
    form.append('type', 'input');
    form.append('overwrite', '1');
    const r = await fetch(joinUrl(baseUrl, '/upload/image'), { method: 'POST', body: form });
    if (!r.ok) {
        const text = await r.text();
        throw new Error(`upload/image ${r.status}: ${text.slice(0, 300)}`);
    }
    return await r.json();
}

export { info, init };
export default { info, init };
