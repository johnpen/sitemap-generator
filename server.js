const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { create } = require('xmlbuilder2');
const cors = require('cors');

const app = express();
app.set('trust proxy', true);
const port = process.env.PORT || 3002;
const rateLimit = require('express-rate-limit');

// Add rate limiting to prevent overloading the website
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    store: new rateLimit.MemoryStore(), // Use memory store for rate limiting
    keyGenerator: function (req) {
        // Use the real IP address from Heroku's proxy
        return req.headers['x-forwarded-for'] || req.ip;
    }
});

app.use(limiter);

app.use(cors());
app.use(express.json());

// Helper function to extract domain from URL
function getDomain(url) {
    const match = url.match(/^(?:https?:\/\/)?(?:[^@\n]+@)?(?:www\.)?([^:\/\n]+)/);
    return match ? match[1] : null;
}

// Helper function to check if URL belongs to the same domain
function isSameDomain(baseUrl, url) {
    const baseDomain = getDomain(baseUrl);
    const urlDomain = getDomain(url);
    return baseDomain === urlDomain;
}

// Function to crawl website and generate sitemap
async function generateSitemap(url) {
    const baseUrl = url;
    const visitedUrls = new Set();
    const urlsToVisit = new Set([url]);
    const builder = create({
        version: '1.0',
        encoding: 'UTF-8',
        standalone: true
    }).ele('urlset', { xmlns: 'http://www.sitemaps.org/schemas/sitemap/0.9' });

    // Function to create a URL element with proper XML escaping
    function createUrlElement(url) {
        try {
            const urlElement = builder.ele('url');
            urlElement.ele('loc', url);
            urlElement.ele('changefreq', 'monthly');
            urlElement.ele('priority', '0.8');
            return urlElement.up();
        } catch (error) {
            console.error(`Error creating XML element for URL ${url}:`, error);
            return null;
        }
    }

    // Function to create a URL element with proper XML escaping
    function createUrlElement(url) {
        try {
            const urlElement = builder.ele('url');
            urlElement.ele('loc', url);
            urlElement.ele('changefreq', 'monthly');
            urlElement.ele('priority', '0.8');
            return urlElement.up();
        } catch (error) {
            console.error(`Error creating XML element for URL ${url}:`, error);
            return null;
        }
    }
    const sitemapUrls = []; // Track URLs for progress logging
    const maxAttempts = 5;
    const maxPagesPerParent = 10;
    const maxConcurrentRequests = 5; // Number of concurrent requests
    const rateLimitWindow = 1000; // 1 second window
    const maxRequestsPerWindow = 5; // Maximum requests per second
    const maxDepth = 3; // Maximum depth to crawl
    let attempts = 0;
    let currentDepth = 0;
    let requestCount = 0;
    let lastRequestTime = Date.now();

    // Track URL depth
    const urlDepthMap = new Map();
    urlDepthMap.set(baseUrl, 0);

    // Track parent-child relationships
    const parentChildMap = new Map();
    const parentCounts = new Map();
    const addedUrls = new Set(); // Track URLs added to sitemap

    // Function to crawl a URL
    async function crawlUrl(url) {
        try {
            // Add delay between requests to be polite
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            console.log(`Crawling URL: ${url}`);
            
            // Make the request with proper error handling
            const response = await axios.get(url, {
                maxRedirects: 5,
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                validateStatus: function (status) {
                    return status >= 200 && status < 400; // Accept all 2xx status codes
                }
            });

            console.log(`Successfully got response for ${url}`);
            
            // Check if we got HTML content
            if (!response.data || !response.data.includes('<html')) {
                console.log(`Skipping non-HTML content at ${url}`);
                return { success: false, url, error: 'Non-HTML content' };
            }

            // Handle redirects
            const finalUrl = response.request.res.responseUrl || url;
            if (finalUrl !== url) {
                console.log(`Redirected from ${url} to ${finalUrl}`);
                url = finalUrl;
            }

            const $ = cheerio.load(response.data);
            console.log(`Found ${$('a').length} links on page ${url}`);
            const childUrls = new Set();

            $('a').each((index, element) => {
                const href = $(element).attr('href');
                if (!href) {
                    console.log(`Skipping empty href at index ${index}`);
                    return;
                }

                // Normalize URL
                let fullUrl = href;
                if (!href.startsWith('http')) {
                    try {
                        const urlObj = new URL(href, baseUrl);
                        // Remove query parameters and hash
                        urlObj.search = '';
                        urlObj.hash = '';
                        fullUrl = urlObj.href;
                    } catch (e) {
                        console.log(`Skipping invalid URL at index ${index}: ${href}`);
                        return;
                    }
                }

                // Only add URLs from the same domain
                if (isSameDomain(baseUrl, fullUrl)) {
                    try {
                        const urlObj = new URL(fullUrl);
                        
                        // Remove query parameters and hash
                        urlObj.search = '';
                        urlObj.hash = '';
                        
                        // Remove common tracking parameters
                        const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
                        paramsToRemove.forEach(param => urlObj.searchParams.delete(param));
                        
                        // Remove empty parameters
                        urlObj.searchParams.forEach((value, key) => {
                            if (!value) {
                                urlObj.searchParams.delete(key);
                            }
                        });
                        
                        // Remove trailing slash if not needed
                        if (urlObj.pathname.endsWith('/') && urlObj.pathname !== '/') {
                            urlObj.pathname = urlObj.pathname.slice(0, -1);
                        }
                        
                        // Add cleaned URL
                        const normalizedUrl = urlObj.toString();
                        if (!visitedUrls.has(normalizedUrl)) {
                            urlsToVisit.add(normalizedUrl);
                            urlDepthMap.set(normalizedUrl, urlDepthMap.get(url) + 1);
                            console.log(`Added URL to queue: ${normalizedUrl} (depth: ${urlDepthMap.get(normalizedUrl)})`);
                        } else {
                            console.log(`Skipping already visited URL: ${normalizedUrl}`);
                        }
                    } catch (e) {
                        console.log(`Skipping invalid URL after normalization: ${fullUrl}`);
                        return;
                    }
                }
            });

            // Add common pages
            const commonPages = [
                '/about-us',
                '/contact',
                '/shipping',
                '/returns',
                '/privacy-policy',
                '/terms-and-conditions'
            ];
            
            commonPages.forEach(page => {
                const fullUrl = new URL(page, baseUrl).href;
                if (!visitedUrls.has(fullUrl)) {
                    urlsToVisit.add(fullUrl);
                }
            });

            // Only add URL to sitemap if it hasn't been added before
            if (!addedUrls.has(url)) {
                try {
                    const urlElement = builder.ele('url');
                    urlElement.ele('loc', url);
                    urlElement.ele('changefreq', 'monthly');
                    urlElement.ele('priority', '0.8');
                    urlElement.up();
                    addedUrls.add(url);
                } catch (error) {
                    console.error(`Error adding URL to sitemap: ${url}`, error);
                }
            }

            visitedUrls.add(url);
        } catch (error) {
            console.error(`Error processing ${url}:`, error);
        }
    }

    try {
        while (urlsToVisit.size > 0 && attempts < maxAttempts) {
            // Get a batch of URLs to process
            const urlsBatch = Array.from(urlsToVisit).slice(0, maxConcurrentRequests);
            urlsToVisit.clear();

            // Rate limiting
            const currentTime = Date.now();
            const timeSinceLastRequest = currentTime - lastRequestTime;
            if (timeSinceLastRequest < rateLimitWindow) {
                const waitTime = rateLimitWindow - timeSinceLastRequest;
                console.log(`Rate limiting: Waiting ${waitTime}ms before next request`);
                try {
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                } catch (error) {
                    console.error('Error waiting for rate limit:', error);
                }
            }
            lastRequestTime = currentTime;

            // Process each URL in parallel with rate limiting
            const results = await Promise.all(
                urlsBatch.map(async (url) => {
                    try {
                        // Get URL depth
                        const depth = urlDepthMap.get(url) || 0;
                        
                        // Skip if we've reached max depth
                        if (depth > maxDepth) {
                            return { success: true, url, childUrls: [] };
                        }

                        // Process the URL
                        const result = await crawlUrl(url);
                        
                        // Add current URL to sitemap
                        if (!addedUrls.has(result.url)) {
                            try {
                                const urlElement = builder.ele('url');
                                urlElement.ele('loc', result.url);
                                urlElement.ele('changefreq', 'monthly');
                                urlElement.ele('priority', '0.8');
                                urlElement.up();
                                addedUrls.add(result.url);
                            } catch (error) {
                                console.error(`Error adding URL to sitemap: ${result.url}`, error);
                            }
                        }

                        // Log progress
                        console.log(`Processed: ${url}`);
                        console.log(`Current queue size: ${urlsToVisit.size}`);
                        console.log(`Visited URLs count: ${visitedUrls.size}`);
                        console.log(`Current depth: ${depth}`);
                        console.log(`Rate limiting status: ${requestCount}/${maxRequestsPerWindow} requests in last ${rateLimitWindow}ms`);

                        // Add to visited URLs
                        visitedUrls.add(url);
                        attempts = 0; // Reset attempts when successful

                        // Add child URLs to queue
                        result.childUrls.forEach(childUrl => {
                            if (!visitedUrls.has(childUrl)) {
                                urlsToVisit.add(childUrl);
                                urlDepthMap.set(childUrl, depth + 1);
                            }
                        });

                        return result;
                    } catch (error) {
                        console.error(`Error crawling ${url}:`, {
                            message: error.message,
                            status: error?.response?.status,
                            statusText: error?.response?.statusText,
                            headers: error?.response?.headers
                        });
                        
                        // Log the current state of the crawling
                        console.log(`Current crawling state:`);
                        console.log(`- Visited URLs: ${visitedUrls.size}`);
                        console.log(`- URLs to visit: ${urlsToVisit.size}`);
                        console.log(`- Attempts: ${attempts}`);
                        
                        // Handle rate limiting
                        if (error?.response?.status === 429) {
                            console.log('Rate limit hit. Waiting 5 seconds...');
                            await new Promise(resolve => setTimeout(resolve, 5000));
                        }

                        attempts++;
                        if (attempts >= maxAttempts) {
                            console.error(`Max attempts reached. Stopping crawler.`);
                            return { success: false, url, error: 'Max attempts reached' };
                        }

                        return { success: false, url, error: error.message };
                    }
                })
            );

            // Check if any of the results were unsuccessful
            if (results.some(result => !result.success)) {
                attempts++;
            }
        }

        return builder.end({ prettyPrint: true });
    } catch (error) {
        console.error('Error in main crawling loop:', error);
        return builder.end({ prettyPrint: true });
    }
}

// API endpoint to generate sitemap
app.post('/generate-sitemap', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const sitemapXml = await generateSitemap(url);
        res.header('Content-Type', 'application/xml');
        res.send(sitemapXml);
    } catch (error) {
        console.error('Error in POST endpoint:', error);
        res.status(500).json({ error: error.message || 'Failed to generate sitemap' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    console.log('To generate a sitemap, use:');
    console.log('curl -X POST http://localhost:3001/generate-sitemap -H "Content-Type: application/json" -d "{\"url\": \"https://example.com\"}"');
});
