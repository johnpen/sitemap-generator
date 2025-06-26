# Sitemap Generator

A Node.js web application that generates sitemap.xml files for websites.

## Features

- Crawls website structure
- Generates valid sitemap.xml
- Stays within the same domain
- Handles relative URLs
- Includes proper sitemap metadata (changefreq, priority)

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

Start the server:
```bash
npm start
```

Use the API endpoint:
```bash
POST http://localhost:3000/generate-sitemap
Content-Type: application/json

{
    "url": "https://example.com"
}
```

The response will be a valid sitemap.xml file.

## API Endpoints

- POST `/generate-sitemap` - Generate sitemap for a website
  - Request body: `{ "url": "https://example.com" }`
  - Response: `application/xml` sitemap
