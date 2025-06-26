const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const sitemap = require('sitemap');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;
const rateLimit = require('express-rate-limit');

// Add rate limiting to prevent overloading the website
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

app.use(limiter);

app.use(cors());
app.use(express.json());

// POST endpoint for generating sitemap
app.post('/generate-sitemap', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const sitemapXml = await generateSitemap(url);
        // Convert XML to string before sending
        res.header('Content-Type', 'application/xml');
        res.send(sitemapXml.toString());
    } catch (error) {
        console.error('Error in POST endpoint:', error);
        res.status(500).json({ error: error.message || 'Failed to generate sitemap' });
    }
});

// GET endpoint for generating sitemap
app.get('/generate-sitemap', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const sitemapXml = await generateSitemap(url);
        // Convert XML to string before sending
        res.header('Content-Type', 'application/xml');
        res.send(sitemapXml.toString());
    } catch (error) {
        console.error('Error in GET endpoint:', error);
        res.status(500).json({ error: error.message || 'Failed to generate sitemap' });
    }
});

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
    const sitemap = new sitemap.Sitemap();
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
                        fullUrl = new URL(href, baseUrl).href;
                    } catch (e) {
                        console.log(`Skipping invalid URL at index ${index}: ${href}`);
                        return;
                    }
                }

                // Only add URLs from the same domain
                if (isSameDomain(baseUrl, fullUrl)) {
                    // Clean up URL by removing unnecessary parameters
                    const urlObj = new URL(fullUrl);
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
                sitemap.add({
                    url: url,
                    changefreq: 'monthly',
                    priority: 0.8
                });
                addedUrls.add(url);
            }

            visitedUrls.add(url);
        } catch (error) {
            console.error(`Error processing ${url}:`, error);
            continue;
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
                        
                        // Add current URL to sitemap regardless of success
                        sitemapUrls.push({
                            url: result.url,
                            changefreq: 'monthly',
                            priority: 0.8
                        });

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

        // Create and return sitemap
        const sitemapXml = sitemap.createSitemap({
            hostname: baseUrl,
            urls: sitemapUrls
        });

        console.log(`Generated sitemap with ${sitemapUrls.length} URLs`);
        return sitemapXml;
    } catch (error) {
        console.error('Error in main crawling loop:', error);
        return sitemap.createSitemap({
            hostname: baseUrl,
            urls: []
        });
    }
}

// API endpoint to generate sitemap
app.post('/generate-sitemap', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        const sitemapObj = await generateSitemap(url);
        const sitemapXml = sitemapObj.toString();
        res.header('Content-Type', 'application/xml');
        res.send(sitemapXml);
    } catch (error) {
        console.error('Error details:', {
            message: error.message,
            name: error.name,
            stack: error.stack
        });
        res.status(500).json({ 
            error: 'Failed to generate sitemap',
            details: error.message
        });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    console.log('To generate a sitemap, use:');
    console.log('curl -X POST http://localhost:3000/generate-sitemap -H \"Content-Type: application/json\" -d \"{\"url\": \"https://example.com\"}\"\'');
});
