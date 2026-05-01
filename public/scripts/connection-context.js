/**
 * Connection-context: per-call connection profile overrides for generation entry points.
 *
 * Generation paths (Generate, generateRaw, generateRawData, generateQuietPrompt) all read from
 * shared globals (main_api, oai_settings, textgen_settings, secret_state, etc). Without
 * coordination, an extension that wants to use a different profile for a single call would race
 * against any other in-flight generation: the swap mutates globals mid-read.
 *
 * This module provides a single chained mutex and a snapshot-apply-restore primitive.
 *
 * Usage:
 *   await withConnectionProfile(profileId, async () => { ... do generation ... });
 *
 * If `profileId` is null/empty/unknown, the function is a transparent pass-through (still under
 * the mutex). Profile resolution + apply is delegated to the connection-manager extension via
 * `registerConnectionProfileProvider()`. If no provider is registered (extension disabled), the
 * override silently no-ops.
 */

let provider = null;

/**
 * @typedef {Object} ConnectionProfileProvider
 * @property {(id: string) => any} getProfileById
 * @property {() => Promise<any>} snapshotCurrent      // Returns an opaque profile object
 * @property {(profile: any) => Promise<void>} applyProfile
 */

/**
 * Register the provider that supplies snapshot/apply primitives. Called by the connection-manager
 * extension at init time.
 * @param {ConnectionProfileProvider} impl
 */
export function registerConnectionProfileProvider(impl) {
    provider = impl;
}

/**
 * Per-feature profile resolver. Looks up which profile id (if any) is assigned to a feature
 * key by the multi-profile extension.
 *
 * Feature keys are short strings the four call sites pass in:
 *   'chat'        — main roleplay generation
 *   'memory'      — summary extension
 *   'expressions' — character expression classifier
 *   'sd'          — image generation prompt
 */
let featureProfileResolver = (_featureId) => null;

/**
 * @param {(featureId: string) => string|null} fn
 */
export function registerFeatureProfileResolver(fn) {
    featureProfileResolver = fn;
}

/**
 * @param {string} featureId
 * @returns {string|null}
 */
export function getFeatureProfile(featureId) {
    try {
        return featureProfileResolver(featureId) || null;
    } catch (e) {
        console.warn('[connection-context] feature profile resolver threw', e);
        return null;
    }
}

/**
 * Promise-chain mutex. All generations serialise through here so a concurrent profile swap
 * cannot mutate globals mid-generation in another caller.
 *
 * Tradeoff: when no override is active, this still serialises generations from the same browser
 * tab. ST already serialises user-input generations elsewhere; this only adds a mild overhead
 * for parallel quiet generations (which are uncommon outside multi-profile usage).
 */
const generationMutex = (() => {
    let chain = Promise.resolve();
    return {
        /**
         * @template T
         * @param {() => Promise<T>} fn
         * @returns {Promise<T>}
         */
        run(fn) {
            const previous = chain;
            let release;
            chain = new Promise((resolve) => { release = resolve; });
            return previous.then(fn, fn).finally(release);
        },
    };
})();

/**
 * Run `fn` with the given connection profile temporarily applied. The previous state is captured
 * before the swap and restored after, regardless of whether `fn` resolves or rejects.
 *
 * Fast path: if `profileId` is null/empty/unknown, no override is requested and `fn` runs directly
 * without acquiring the mutex. This avoids deadlocks if `fn` itself triggers re-entrant generation
 * (e.g., extension event handlers that call generateRaw inside a Generate flow), and removes the
 * serialisation overhead from the common no-override case. The race-protection guarantee is then
 * weaker — concurrent override + non-override calls can briefly observe swapped globals — but
 * deadlock-freeness wins.
 *
 * @template T
 * @param {string|null|undefined} profileId  Profile id to apply, or null/empty for pass-through.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withConnectionProfile(profileId, fn) {
    if (!profileId || !provider) {
        return await fn();
    }

    const target = provider.getProfileById(profileId);
    if (!target) {
        console.warn(`[connection-context] profile ${profileId} not found; running with current profile`);
        return await fn();
    }

    return generationMutex.run(async () => {
        console.log('[connection-context] swap → snapshotting current state');
        const snapshot = await provider.snapshotCurrent();
        console.log('[connection-context] snapshot:', JSON.parse(JSON.stringify(snapshot)));
        console.log('[connection-context] applying override profile:', target.name, JSON.parse(JSON.stringify(target)));
        try {
            await provider.applyProfile(target);
            await waitForConnection('after override apply');
            console.log('[connection-context] override applied; running fn');
            const result = await fn();
            console.log('[connection-context] fn returned:', typeof result, result === undefined ? '(undefined)' : result === null ? '(null)' : (typeof result === 'string' ? `"${result.slice(0, 80)}"` : '...'));
            return result;
        } finally {
            console.log('[connection-context] restoring snapshot');
            try {
                await provider.applyProfile(snapshot);
                await waitForConnection('after snapshot restore');
                console.log('[connection-context] snapshot restored');
            } catch (e) {
                console.error('[connection-context] failed to restore previous connection profile', e);
            }
        }
    });
}

/**
 * After a profile apply, the new connection may still be in flight (the /api-url slash command
 * triggers the connect button asynchronously and returns immediately). If we proceed to Generate()
 * before the connection comes online, Generate sees online_status==='no_connection' and bails
 * out returning undefined. Wait briefly for the connection to settle.
 */
async function waitForConnection(label) {
    const onlineStatus = globalThis.online_status ?? (await import('../script.js')).online_status;
    const deadline = Date.now() + 5000;
    let current = onlineStatus;
    let lastSeen = current;
    while (Date.now() < deadline) {
        // Re-read by re-importing the live binding each tick. This module-eval cost is amortised
        // because the import is cached after the first call.
        // eslint-disable-next-line no-await-in-loop
        const mod = await import('../script.js');
        current = mod.online_status;
        if (current && current !== 'no_connection') {
            if (lastSeen !== current) {
                console.log(`[connection-context] online_status=${current} (${label})`);
            }
            return;
        }
        lastSeen = current;
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, 100));
    }
    console.warn(`[connection-context] connection did not come online within 5s (${label}), online_status=${current}`);
}
