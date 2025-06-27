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
            urlElement.ele('loc').txt(url);
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
            urlElement.ele('loc').txt(url);
            return urlElement.up();
        } catch (error) {
            console.error(`Error creating XML element for URL ${url}:`, error);
            return null;
        }
    }
    const sitemapUrls = []; // Track URLs for progress logging
    const maxAttempts = 200;
    const maxPagesPerParent = 15; // Maximum child pages per parent URL (not counting duplicates)
    const maxConcurrentRequests = 10; // Number of concurrent requests
    const rateLimitWindow = 300; // 1 second window
    const maxRequestsPerWindow = 50; // Maximum requests per second
    const maxDepth = 5; // Maximum depth to crawl
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
            if(visitedUrls.has(url)){
                urlsToVisit.delete(url);
                return;
            }
            // Add delay between requests to be polite
            await new Promise(resolve => setTimeout(resolve, 1000));
            if(!visitedUrls.has(url)){
                visitedUrls.add(url);
            }            
            urlsToVisit.delete(url);
            
            console.log(`Crawling URL: ${url}`);
            
            // Send progress update
            if (res) {
                res.write(`data: ${JSON.stringify({ type: 'progress', url, status: 'crawling' })}\n\n`);
            }
            
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

            // Track number of child pages added for this parent
            let childPagesAdded = 0;
            
            // Don't limit child pages for home page
            const isHomePage = url === baseUrl;
            
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

                    urlObj.search = ''
                    /*
                    const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
                    paramsToRemove.forEach(param => urlObj.searchParams.delete(param));
                    
                    // Remove empty parameters
                    urlObj.searchParams.forEach((value, key) => {
                     //   if (!value) {
                            urlObj.searchParams.delete(key);
                     //   }
                    }); */
                    
                    // Remove trailing slash if not needed
                    if (urlObj.pathname.endsWith('/') && urlObj.pathname !== '/') {
                        urlObj.pathname = urlObj.pathname.slice(0, -1);
                    }
                    
                    // Add cleaned URL
                    const normalizedUrl = urlObj.toString();
                    if (!visitedUrls.has(normalizedUrl)) {
                        // Add URL to queue if not already visited
                        if(!urlsToVisit.has(normalizedUrl)){
                        urlsToVisit.add(normalizedUrl);
                        urlDepthMap.set(normalizedUrl, urlDepthMap.get(url) + 1);
                        console.log(`Added URL to queue: ${normalizedUrl} (depth: ${urlDepthMap.get(normalizedUrl)})`);
                       
                        // Only increment counter for non-home pages
                        if (!isHomePage) {
                            childPagesAdded++;
                            
                            // Stop adding child pages if we've reached the limit
                            if (childPagesAdded >= maxPagesPerParent) {
                                console.log(`Reached max child pages (${maxPagesPerParent}) for parent URL: ${url}`);
                                return false; // Break out of each loop
                            }
                        }
                    }
                    } else {
                        console.log(`Skipping already visited URL: ${normalizedUrl}`);
                    }
                }
            });



            // Only add URL to sitemap if it hasn't been added before
            if (!addedUrls.has(url)) {
                const urlElement = createUrlElement(url);
                if (urlElement) {

                    addedUrls.add(url);
                }
            }

       
        } catch (error) {
            console.error(`Error processing ${url}:`, error);
        }
    }

    try {
        while (urlsToVisit.size > 0 && attempts < maxAttempts) {
            // Get a batch of URLs to process
            const urlsBatch = Array.from(urlsToVisit).slice(0, maxConcurrentRequests);
           // urlsToVisit.clear();

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
                            return { success: false};
                        }

                        // Process the URL
                        const result = await crawlUrl(url);

                        if(!result){
                            return { success: false };
                        }
                        
                        // Add current URL to sitemap
                        if (!addedUrls.has(result.url)) {
                            const urlElement = createUrlElement(result.url);
                            if (urlElement) {
                                addedUrls.add(result.url);
                            }
                        }
                          

                        // Log progress
                        console.log(`Processed: ${url}`);
                        console.log(`Current queue size: ${urlsToVisit.size}`);
                        console.log(`Visited URLs count: ${visitedUrls.size}`);
                        console.log(`Current depth: ${depth}`);
                        console.log(`Rate limiting status: ${requestCount}/${maxRequestsPerWindow} requests in last ${rateLimitWindow}ms`);

                        // Send progress update
                        if (res) {
                            res.write(`data: ${JSON.stringify({ 
                                type: 'progress', 
                                url: result.url, 
                                status: 'processed',
                                depth,
                                totalVisited: visitedUrls.size,
                                queueSize: urlsToVisit.size
                            })}\n\n`);
                        }

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

        return builder.end({ prettyPrint: false });
    } catch (error) {
        console.error('Error in main crawling loop:', error);
        return builder.end({ prettyPrint: false });
    }
}

// POST endpoint for generating sitemap with streaming
app.post('/generate-sitemap', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Set headers for SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Create a promise that will resolve when the sitemap is complete
        const sitemapPromise = generateSitemap(url);

        // Send initial message
        res.write('data: Starting sitemap generation...\n\n');

        // Handle the sitemap generation
        sitemapPromise.then(sitemapXml => {
            // Send final sitemap
            res.write(`data: ${JSON.stringify({ type: 'complete', sitemap: sitemapXml })}\n\n`);
            res.end();
        }).catch(error => {
            console.error('Error in sitemap generation:', error);
            res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
            res.end();
        });

        // Handle client disconnect
        req.on('close', () => {
            console.log('Client disconnected');
        });
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
