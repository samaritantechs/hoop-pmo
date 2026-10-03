package com.samaritantechs.hoopcalls;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A PLACE OPENS IN MAPS, NOT IN A BROWSER TAB.
 * -------------------------------------------------------------------------------------------
 *   "Hooploan app doesn't open location links into maps as hopeloan does, just still works
 *    for link visiting via browser only"
 *
 * Every location the portal shows -- a handset's last fix on the Devices register, a new-stock
 * row's pin -- is a plain Google Maps web address, because that is what a browser on a desk
 * can open. Handed to Android as that web address it is the PHONE's decision which app gets
 * it: Google Maps, if the handset has verified google.com links for it; the browser if not,
 * or if an officer once tapped "Chrome, always" at a chooser. That verification is per
 * handset and per Android release, which is why the same link lands in Maps on one phone and
 * in a browser tab on the next, and why fixing the address on the page could never settle it.
 *
 * A `geo:` address settles it. It is the one scheme a maps app registers for outright, with
 * no domain to verify and no browser in the running, and it is what Google documents for
 * "open this point in Maps". So a web link that is recognisably a point on a map is first
 * offered to the phone as `geo:lat,lng?q=lat,lng`; only if nothing on the handset takes
 * THAT does the original web address go out, exactly as before -- so a phone with no maps
 * app at all keeps today's behaviour and never does worse.
 *
 * This class is deliberately plain Java -- no android.* import anywhere -- so the rule can be
 * compiled and run by the test suite on an ordinary JDK, where the Activity around it cannot.
 */
final class MapLink {
    private MapLink() {}

    /* scheme://host[:port][/path][?query][#fragment] -- only the pieces this needs, read with
       a regex rather than java.net.URI, which throws on the spaces and brackets a real-world
       link can carry and would turn a strange address into a crash on the one tap it was
       meant to help. Hosts: google.com, www.google.com, maps.google.com, and the country
       ones (google.co.tz, google.co.ke, google.com.au, google.de); anything else is not
       Google Maps. */
    private static final Pattern LINK = Pattern.compile(
            "(?i)^https?://(?:www\\.|maps\\.)?google\\.(?:com|com\\.[a-z]{2}|co\\.[a-z]{2}|[a-z]{2})(?::\\d+)?"
            + "(/[^?#]*)?(?:\\?([^#]*))?(?:#.*)?$");

    /* "lat,lng", as the page writes it (toFixed(6) or the raw numbers), with the comma either
       bare or %2C-encoded by encodeURIComponent -- decoded before this is applied. A minus
       sign and nothing else: the pair is pasted into the geo: address verbatim, whose grammar
       (RFC 5870) has no '+', and a '+' in a query is a space to half the parsers out there. */
    private static final Pattern PAIR = Pattern.compile(
            "^\\s*(-?\\d{1,3}(?:\\.\\d+)?)\\s*,\\s*(-?\\d{1,3}(?:\\.\\d+)?)\\s*$");

    /**
     * The `geo:` form of a Google Maps web link that points at a coordinate pair, or null when
     * the link is anything else -- another site, a Maps page with no point in it (a place
     * page, a route), a search for a name rather than a position, or a pair that is not on
     * the globe. Null means "hand the address out as it is", never "drop it".
     */
    static String geoFor(String url) {
        if (url == null) return null;
        Matcher m = LINK.matcher(url.trim());
        if (!m.matches()) return null;
        String path = m.group(1) == null ? "" : m.group(1);
        // maps.google.com/?q=..., google.com/maps?q=..., google.com/maps/search/?query=...
        if (!(path.isEmpty() || path.equals("/") || path.equals("/maps") || path.startsWith("/maps/"))) {
            return null;
        }
        String q = param(m.group(2), "q");
        if (q == null) q = param(m.group(2), "query");   // the ?api=1 form of the same link
        if (q == null) return null;
        Matcher p = PAIR.matcher(q);
        if (!p.matches()) return null;
        double lat, lng;
        try {
            lat = Double.parseDouble(p.group(1));
            lng = Double.parseDouble(p.group(2));
        } catch (NumberFormatException e) {
            return null;
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
        String pair = p.group(1) + "," + p.group(2);
        return "geo:" + pair + "?q=" + pair;
    }

    /** The first value of `name` in a query string, percent-decoded; null when absent. */
    private static String param(String query, String name) {
        if (query == null) return null;
        for (String part : query.split("&")) {
            int eq = part.indexOf('=');
            String key = eq < 0 ? part : part.substring(0, eq);
            if (!key.equals(name)) continue;
            String value = eq < 0 ? "" : part.substring(eq + 1);
            try {
                return java.net.URLDecoder.decode(value, "UTF-8");
            } catch (Exception e) {
                return value;           // a malformed %-sequence is still a value, just not a pair
            }
        }
        return null;
    }
}
