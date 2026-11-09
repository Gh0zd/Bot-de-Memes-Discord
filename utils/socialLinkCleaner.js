const SOCIAL_NETWORKS = [
    { name: "Instagram", domains: ["instagram.com", "instagr.am"] },
    { name: "X/Twitter", domains: ["twitter.com", "x.com", "t.co"] },
    { name: "TikTok", domains: ["tiktok.com"] },
    { name: "Facebook", domains: ["facebook.com", "fb.com", "fb.watch", "m.me"] },
    { name: "YouTube", domains: ["youtube.com", "youtu.be", "youtube-nocookie.com"] },
    { name: "Reddit", domains: ["reddit.com", "redd.it"] },
    { name: "LinkedIn", domains: ["linkedin.com", "lnkd.in"] },
    { name: "Pinterest", domains: ["pinterest.com", "pin.it"] },
    { name: "Snapchat", domains: ["snapchat.com", "snap.com"] },
    { name: "Threads", domains: ["threads.net"] },
    { name: "Telegram", domains: ["t.me", "telegram.me", "telegram.org"] },
    { name: "WhatsApp", domains: ["whatsapp.com", "wa.me"] },
    { name: "Twitch", domains: ["twitch.tv"] },
    { name: "Discord", domains: ["discord.com", "discord.gg"] },
    { name: "Tumblr", domains: ["tumblr.com"] },
    { name: "Bluesky", domains: ["bsky.app"] }
];

const SOCIAL_DOMAINS = SOCIAL_NETWORKS
    .flatMap(network => network.domains)
    .sort((left, right) => right.length - left.length);
const BARE_SOCIAL_LINK_PATTERN = new RegExp(
    `(?<![@\\w.-])(?:${SOCIAL_DOMAINS.map(domain => domain.replace(/\./g, "\\.")).join("|")})\\/[^\\s<>()]*`,
    "gi"
);
const URL_PATTERN = new RegExp(
    `https?:\\/\\/[^\\s<>()]+|www\\.[^\\s<>()]+|${BARE_SOCIAL_LINK_PATTERN.source}`,
    "gi"
);

const COMMON_TRACKING_PARAMETERS = new Set([
    "fbclid",
    "gclid",
    "dclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "igsh",
    "igshid",
    "ref_src",
    "ref_url",
    "vero_id",
    "oly_anon_id",
    "oly_enc_id",
    "mkt_tok"
]);

const NETWORK_TRACKING_PARAMETERS = {
    instagram: new Set(["mdxt", "srtk"]),
    "x/twitter": new Set(["s", "t"]),
    tiktok: new Set([
        "_r",
        "_t",
        "checksum",
        "enable_checksum",
        "enter_method",
        "is_from_webapp",
        "sender_device",
        "sender_web_id",
        "share_app_id",
        "share_link_id"
    ]),
    facebook: new Set(["mibextid", "__cft__", "__tn__"]),
    youtube: new Set(["si"]),
    linkedin: new Set(["lipi", "midsig", "midtoken", "originalsubdomain", "trackingid", "trk"]),
    snapchat: new Set(["sc_referrer", "scid"])
};

function getSocialNetwork(hostname) {
    const host = hostname.toLowerCase().replace(/^www\./, "");
    return SOCIAL_NETWORKS.find(network =>
        network.domains.some(domain => host === domain || host.endsWith(`.${domain}`))
    )?.name || null;
}

function getTrackingParameters(network) {
    const networkParameters = NETWORK_TRACKING_PARAMETERS[
        network?.toLowerCase()
    ] || new Set();
    return new Set([...COMMON_TRACKING_PARAMETERS, ...networkParameters]);
}

function cleanTrackedSocialLinks(content) {
    const cleanedLinks = [];

    for (const match of content.matchAll(URL_PATTERN)) {
        const matchedUrl = match[0];
        const trailingPunctuation = matchedUrl.match(/[.,!?;:]+$/)?.[0] || "";
        const link = trailingPunctuation
            ? matchedUrl.slice(0, -trailingPunctuation.length)
            : matchedUrl;

        let url;
        try {
            url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
        } catch {
            continue;
        }

        const network = getSocialNetwork(url.hostname);
        const trackingParameters = getTrackingParameters(network);
        const removedParameters = [];
        for (const parameter of [...url.searchParams.keys()]) {
            const normalizedParameter = parameter.toLowerCase();
            if (
                trackingParameters.has(normalizedParameter) ||
                normalizedParameter.startsWith("utm_")
            ) {
                url.searchParams.delete(parameter);
                removedParameters.push(parameter);
            }
        }

        if (removedParameters.length === 0) continue;

        cleanedLinks.push({
            network: network || url.hostname.replace(/^www\./i, ""),
            url: url.toString(),
            originalUrl: matchedUrl,
            cleanedUrl: `${url}${trailingPunctuation}`,
            removedParameters
        });
    }

    return cleanedLinks;
}

function cleanTrackedLinksInText(content) {
    const links = cleanTrackedSocialLinks(content);
    return {
        content: links.reduce(
            (text, link) => text.replace(link.originalUrl, link.cleanedUrl),
            content
        ),
        links
    };
}

function formatLinksAsMarkdown(content) {
    return content.replace(URL_PATTERN, matchedUrl => {
        const trailingPunctuation = matchedUrl.match(/[.,!?;:]+$/)?.[0] || "";
        const link = trailingPunctuation
            ? matchedUrl.slice(0, -trailingPunctuation.length)
            : matchedUrl;
        let url;
        try {
            url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
        } catch {
            return matchedUrl;
        }

        const network = getSocialNetwork(url.hostname);
        const label = network
            ? `Ver en ${network}`
            : `Abrir ${url.hostname.replace(/^www\./i, "")}`;
        const markdownUrl = url.toString().replace(/[()]/g, character =>
            character === "(" ? "%28" : "%29"
        );
        return `[${label}](${markdownUrl})${trailingPunctuation}`;
    });
}

module.exports = {
    cleanTrackedSocialLinks,
    cleanTrackedLinksInText,
    formatLinksAsMarkdown
};
