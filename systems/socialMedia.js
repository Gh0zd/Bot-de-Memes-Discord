const path = require("node:path");
const youtubeDl = require("youtube-dl-exec");
const { AsyncQueue } = require("../utils/asyncQueue");

// Limit concurrent media downloads (yt-dlp + fetch) to protect RAM/CPU on busy servers.
const DOWNLOAD_QUEUE = new AsyncQueue(Number(process.env.SOCIAL_DOWNLOAD_CONCURRENCY) || 2);

const VIDEO_PLATFORMS = [
    { name: "TikTok", domains: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"] },
    { name: "Instagram", domains: ["instagram.com", "instagr.am"] },
    { name: "X/Twitter", domains: ["twitter.com", "x.com", "t.co"] },
    { name: "YouTube", domains: ["youtube.com", "youtu.be", "youtube-nocookie.com"] },
    { name: "Facebook", domains: ["facebook.com", "fb.com", "fb.watch"] },
    { name: "Reddit", domains: ["reddit.com", "redd.it"] },
    { name: "LinkedIn", domains: ["linkedin.com", "lnkd.in"] },
    { name: "Pinterest", domains: ["pinterest.com", "pin.it"] },
    { name: "Snapchat", domains: ["snapchat.com"] },
    { name: "Twitch", domains: ["twitch.tv"] },
    { name: "Tumblr", domains: ["tumblr.com"] },
    { name: "Bluesky", domains: ["bsky.app"] },
    { name: "Vimeo", domains: ["vimeo.com"] },
    { name: "Dailymotion", domains: ["dailymotion.com", "dai.ly"] },
    { name: "Rumble", domains: ["rumble.com"] },
    { name: "Bilibili", domains: ["bilibili.com", "b23.tv"] },
    { name: "Kick", domains: ["kick.com"] },
    { name: "Rutube", domains: ["rutube.ru"] },
    { name: "VK", domains: ["vk.com", "vk.ru"] },
    { name: "Streamable", domains: ["streamable.com"] }
];
const PLATFORM_DOMAINS = VIDEO_PLATFORMS
    .flatMap(platform => platform.domains)
    .sort((left, right) => right.length - left.length);
const ESCAPED_PLATFORM_DOMAINS = PLATFORM_DOMAINS
    .map(domain => domain.replace(/\./g, "\\."));
const SOCIAL_URL_REGEX = new RegExp(
    `(?<![A-Z0-9._/-])((?:https?:\\/\\/)?(?:[A-Z0-9-]+\\.)*(?:${ESCAPED_PLATFORM_DOMAINS.join("|")})(?::\\d+)?(?:\\/[^\\s<>()]*)?)`,
    "i"
);
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const REDIRECT_LIMIT = 5;

const ALLOWED_HOST_SUFFIXES = [
    ...PLATFORM_DOMAINS,
    "tiktokcdn.com",
    "tiktokv.com",
    "byteoversea.com",
    "ibytedtos.com",
    "byteimg.com",
    "cdninstagram.com",
    "fbcdn.net",
    "twimg.com",
    "googlevideo.com",
    "googleusercontent.com",
    "ytimg.com",
    "fbsbx.com",
    "vimeocdn.com",
    "akamaized.net",
    "dmcdn.net",
    "pinimg.com",
    "twitchcdn.net",
    "ttvnw.net",
    "jtvnw.net",
    "sc-cdn.net",
    "bilivideo.com",
    "hdslb.com",
    "licdn.com",
    "redd.it",
    "redditmedia.com",
    "redditstatic.com",
    "userapi.com",
    "vkuseraudio.net",
    "rumble.cloud"
];

const MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/ogg": ".ogv",
    "video/3gpp": ".3gp",
    "video/mpeg": ".mpeg",
    "video/x-msvideo": ".avi"
};

class UploadLimitError extends Error {
    constructor(size, limit) {
        super(`Downloaded media is ${size} bytes, above the server limit of ${limit} bytes.`);
        this.name = "UploadLimitError";
        this.size = size;
        this.limit = limit;
    }
}

class MediaUnavailableError extends Error {
    constructor(url, cause) {
        super(`No downloadable video media was exposed by ${url}. The original message must be kept.`, { cause });
        this.name = "MediaUnavailableError";
    }
}

function isAllowedHost(hostname) {
    const host = hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some(domain =>
        host === domain || host.endsWith(`.${domain}`)
    );
}

function validateMediaUrl(value, baseUrl) {
    const url = new URL(value, baseUrl);
    if (url.protocol === "http:") url.protocol = "https:";
    if (
        url.protocol !== "https:" ||
        (url.port && url.port !== "443") ||
        !isAllowedHost(url.hostname) ||
        url.username ||
        url.password
    ) {
        throw new Error(`Rejected non-HTTPS or unsupported media URL: ${url.origin}`);
    }
    return url;
}

function extractSocialUrl(content) {
    const match = content.match(SOCIAL_URL_REGEX);
    if (!match) return null;

    const rawUrl = match[1].replace(/[.,!?;:]+$/, "");
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    } catch {
        return null;
    }

    if (url.port && url.port !== "443") return null;
    if (!isSupportedPlatformHost(url.hostname)) return null;
    if (url.protocol === "http:") url.protocol = "https:";
    return url;
}

function isSupportedPlatformHost(hostname) {
    const host = hostname.toLowerCase();
    return VIDEO_PLATFORMS.some(platform =>
        platform.domains.some(domain => host === domain || host.endsWith(`.${domain}`))
    );
}

function getAllowedUploadBytes(guild) {
    const tier = Number(guild.premiumTier);
    const megabytes = tier >= 3 ? 100 : tier === 2 ? 50 : 10;
    return megabytes * 1024 * 1024;
}

function getMediaType(contentType, url) {
    const mimeType = (contentType || "").split(";")[0].trim().toLowerCase();
    if (Object.hasOwn(MIME_EXTENSIONS, mimeType)) {
        return { mimeType, extension: MIME_EXTENSIONS[mimeType] };
    }
    if (mimeType && mimeType !== "application/octet-stream" &&
        mimeType !== "binary/octet-stream") {
        return null;
    }

    const extension = path.extname(url.pathname).toLowerCase();
    const byExtension = Object.entries(MIME_EXTENSIONS)
        .find(([, allowedExtension]) => allowedExtension === extension);
    return byExtension
        ? { mimeType: byExtension[0], extension }
        : null;
}

function getFilename(url, extension) {
    const candidate = path.basename(decodeURIComponent(url.pathname)).replace(/[^\w.-]/g, "_");
    const safeName = candidate.slice(0, 100);
    return safeName && path.extname(safeName)
        ? safeName
        : `social-media${extension}`;
}

async function fetchWithRedirects(initialUrl) {
    let url = validateMediaUrl(initialUrl.href);

    for (let redirectCount = 0; redirectCount <= REDIRECT_LIMIT; redirectCount++) {
        const response = await fetch(url, {
            redirect: "manual",
            headers: {
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,video/*;q=0.8,image/avif,image/webp,image/apng,*/*;q=0.7",
                "accept-language": "en-US,en;q=0.9",
                referer: "https://www.instagram.com/"
            },
            signal: AbortSignal.timeout(30000)
        });

        if (![301, 302, 303, 307, 308].includes(response.status)) {
            return { response, url };
        }

        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirectCount === REDIRECT_LIMIT) {
            throw new Error(`Social media URL exceeded the ${REDIRECT_LIMIT}-redirect limit.`);
        }
        url = validateMediaUrl(location, url);
    }

    throw new Error("Unable to resolve the social media URL.");
}

async function readBuffer(response, maxBytes) {
    const headerLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(headerLength) && headerLength > maxBytes) {
        await response.body?.cancel();
        throw new UploadLimitError(headerLength, maxBytes);
    }

    if (!response.body) {
        throw new Error("The media response did not contain a readable body.");
    }

    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel();
                throw new UploadLimitError(size, maxBytes);
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}

async function readMetadata(response) {
    const headerLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(headerLength) && headerLength > MAX_METADATA_BYTES) {
        await response.body?.cancel();
        throw new Error("Social media page exceeded the metadata download limit.");
    }
    try {
        const buffer = await readBuffer(response, MAX_METADATA_BYTES);
        return buffer.toString("utf8");
    } catch (error) {
        if (error instanceof UploadLimitError) {
            throw new Error("Social media page exceeded the metadata download limit.");
        }
        throw error;
    }
}

function decodeHtml(value) {
    return value
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\\u002[fF]/g, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003[dD]/g, "=")
        .replace(/\\u003[fF]/g, "?")
        .replace(/\\\//g, "/")
        .trim();
}

function extractMediaCandidates(html, pageUrl) {
    const candidates = { video: [], image: [] };
    const searchableHtml = decodeHtml(html);
    const metaTags = searchableHtml.match(/<meta\b[^>]*>/gi) || [];

    for (const tag of metaTags) {
        const attributes = {};
        for (const match of tag.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
            attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
        }

        const key = (attributes.property || attributes.name || "").toLowerCase();
        const value = attributes.content;
        if (!value) continue;

        if (/^(og:video(?::secure_url|:url)?|twitter:player:stream)$/.test(key)) {
            candidates.video.push(value);
        } else if (/^(og:image(?::secure_url|:url)?|twitter:image(?::src)?)$/.test(key)) {
            candidates.image.push(value);
        }
    }

    for (const match of searchableHtml.matchAll(
        /"(?:playAddr|downloadAddr|contentUrl|videoUrl|video_url)"\s*:\s*"((?:\\.|[^"\\])+)"/gi
    )) {
        let value = match[1];
        try {
            value = JSON.parse(`"${value}"`);
        } catch {
            value = decodeHtml(value);
        }
        candidates.video.push(value);
    }

    for (const match of searchableHtml.matchAll(
        /https?:\\?\/\\?\/[^"'<>\\\s]+?\.mp4(?:\?[^"'<>\\\s]*)?/gi
    )) {
        candidates.video.push(match[0]);
    }

    for (const match of searchableHtml.matchAll(
        /"(?:display_url|image_url|imageUrl)"\s*:\s*"((?:\\.|[^"\\])+)"/gi
    )) {
        let value = match[1];
        try {
            value = JSON.parse(`"${value}"`);
        } catch {
            value = decodeHtml(value);
        }
        candidates.image.push(value);
    }

    for (const type of ["video", "image"]) {
        const validatedCandidates = [];
        for (const candidate of candidates[type]) {
            try {
                validatedCandidates.push(validateMediaUrl(decodeHtml(candidate), pageUrl));
            } catch {
                continue;
            }
        }
        candidates[type] = validatedCandidates;
    }
    return candidates;
}

async function downloadMedia(url, maxBytes, expectedType = null) {
    const { response, url: resolvedUrl } = await fetchWithRedirects(url);
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Media request failed with HTTP ${response.status} for ${resolvedUrl.href}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const mediaType = getMediaType(contentType, resolvedUrl);
    if (mediaType) {
        const actualType = mediaType.mimeType.startsWith("video/") ? "video" : "image";
        if (expectedType && actualType !== expectedType) {
            await response.body?.cancel();
            return null;
        }
        const buffer = await readBuffer(response, maxBytes);
        return {
            buffer,
            contentType: mediaType.mimeType,
            filename: getFilename(resolvedUrl, mediaType.extension)
        };
    }

    if (!contentType.toLowerCase().includes("text/html")) {
        await response.body?.cancel();
        return null;
    }

    const html = await readMetadata(response);
    const candidates = extractMediaCandidates(html, resolvedUrl);
    let lastError;
    const candidateTypes = expectedType
        ? [expectedType]
        : candidates.video.length
            ? ["video"]
            : ["image"];
    for (const type of candidateTypes) {
        for (const candidate of candidates[type]) {
            try {
                const downloaded = await downloadMedia(candidate, maxBytes, type);
                if (downloaded) return downloaded;
            } catch (error) {
                if (error instanceof UploadLimitError) throw error;
                lastError = error;
            }
        }
    }

    if (lastError) throw lastError;
    return null;
}

function getInstagramReelCode(url) {
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/(?:reel|reels|tv)\/([^/]+)/i);
    return match?.[1] || null;
}

async function downloadWithYoutubeDl(url, maxBytes) {
    const info = await youtubeDl(url.href, {
        dumpSingleJson: true,
        noWarnings: true,
        noPlaylist: true,
        format: "best"
    }, {
        timeout: 45000,
        windowsHide: true
    });

    const availableFormats = [
        ...(info.requested_downloads || []),
        ...(info.requested_formats || []),
        ...(info.formats || [])
    ];
    const selectedFormat = availableFormats.find(format =>
        format.url && format.vcodec !== "none" && format.acodec !== "none"
    );
    const mediaUrl = selectedFormat?.url ||
        (info.vcodec && info.vcodec !== "none" &&
            info.acodec && info.acodec !== "none"
            ? info.url
            : null);
    if (!mediaUrl) {
        throw new Error(`yt-dlp could not find a combined audio/video format for ${url.hostname}.`);
    }

    const validatedUrl = validateMediaUrl(mediaUrl);
    const media = await downloadMedia(validatedUrl, maxBytes, "video");
    if (!media) {
        throw new Error(`yt-dlp resolved ${url.hostname}, but its URL did not return a supported video.`);
    }
    return media;
}

async function findAndDownloadSocialMedia(content, guild) {
    const socialUrl = extractSocialUrl(content);
    if (!socialUrl) return null;

    return DOWNLOAD_QUEUE.run(() => downloadSocialMediaJob(content, guild, socialUrl));
}

async function downloadSocialMediaJob(content, guild, socialUrl) {
    const maxBytes = getAllowedUploadBytes(guild);
    const reelCode = getInstagramReelCode(socialUrl);
    const isInstagram = /(^|\.)instagram\.com$/i.test(socialUrl.hostname);
    let downloadError;

    const downloadStrategies = isInstagram
        ? [async () => downloadMedia(socialUrl, maxBytes, reelCode ? "video" : null)]
        : [];
    downloadStrategies.push(
        () => downloadWithYoutubeDl(socialUrl, maxBytes),
        () => downloadMedia(socialUrl, maxBytes, reelCode ? "video" : null)
    );

    if (reelCode) {
        downloadStrategies.push(
            () => downloadMedia(
                new URL(`/reel/${encodeURIComponent(reelCode)}/embed/captioned/`, "https://www.instagram.com"),
                maxBytes,
                "video"
            ),
            () => downloadMedia(
                new URL(`/reel/${encodeURIComponent(reelCode)}/embed/`, "https://www.instagram.com"),
                maxBytes,
                "video"
            )
        );
    }

    for (const download of downloadStrategies) {
        try {
            const media = await download();
            if (media) return media;
        } catch (error) {
            if (error instanceof UploadLimitError) throw error;
            downloadError ||= error;
        }
    }

    throw new MediaUnavailableError(socialUrl.href, downloadError);
}

module.exports = {
    UploadLimitError,
    MediaUnavailableError,
    extractSocialUrl,
    VIDEO_PLATFORMS,
    getAllowedUploadBytes,
    findAndDownloadSocialMedia,
    getDownloadQueueStats: () => ({
        active: DOWNLOAD_QUEUE.active,
        pending: DOWNLOAD_QUEUE.pending
    })
};
