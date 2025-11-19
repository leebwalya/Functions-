// Import DynamoDB clients for simple JSON reads/writes
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

// Create the DynamoDB document client (simpler than raw client)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Name of the cache table (PK = cityKey string, stores 'data' and 'ttl')
const CACHE_TABLE = "EnvCache_Iac";

// async function that handles incoming API requests
export const handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",  // tells the browser sending JSON
    "Access-Control-Allow-Origin": "*",  // allows any website to access this API
    "Access-Control-Allow-Headers": "*", // allows any headers in the request
    "Access-Control-Allow-Methods": "GET,OPTIONS",
  };

  //  API key for OpenWeather
  const OPEN_WEATHER_KEY = "88a72bd4e76e698f2054745bfff3b603";

  try {
    // Handle CORS preflight quickly
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // Pull city param from query string
    const params = event.queryStringParameters || {};
    const city = (params.city || "").trim();

    if (!city) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: "Missing city name" }),
      };
    }

    // Build a normalized key for the cache (lowercase to de-dupe)
    const cityKey = city.toLowerCase();

    // --------- 1) CHECK CACHE FIRST (fast + cheap) ----------
    // current epoch time in seconds
    const now = Math.floor(Date.now() / 1000);

    // Try get existing cached item
    const cached = await ddb.send(
      new GetCommand({
        TableName: CACHE_TABLE,
        Key: { cityKey }, // PK lookup
      })
    );

    // If we found an item AND its ttl is in the future, return cached data
    if (cached.Item && typeof cached.Item.ttl === "number" && cached.Item.ttl > now) {
      // return the cached payload exactly as saved
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, data: cached.Item.data, source: "cache" }),
      };
    }

    // --------- 2) CACHE MISS ⇒ CALL LIVE APIS ----------
    // Get coordinates from OpenWeather geocoding
    const geoRes = await fetch(
      `http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(
        city
      )}&limit=1&appid=${OPEN_WEATHER_KEY}`
    );
    const geoData = await geoRes.json();

    // If the city wasn't found, return an error
    if (!Array.isArray(geoData) || geoData.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ success: false, error: "City not found" }),
      };
    }

    // Get the coordinates and name info from the response
    const { lat, lon, name, country } = geoData[0];

    // Get pollutant data from OpenWeather
    const airRes = await fetch(
      `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${OPEN_WEATHER_KEY}`
    );
    const airData = await airRes.json();

    // store the pollutant values here
    let components = {};
    if (airData.list && airData.list.length > 0) {
      components = airData.list[0].components || {};
    }

    // Get UV index from OpenWeather
    const uvRes = await fetch(
      `https://api.openweathermap.org/data/2.5/uvi?lat=${lat}&lon=${lon}&appid=${OPEN_WEATHER_KEY}`
    );
    const uvData = await uvRes.json();

    // Get AQI from Open-Meteo
    const meteoRes = await fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=us_aqi`
    );
    const meteoData = await meteoRes.json();

    // store the latest AQI value here
     let aqi = "N/A";
    if (meteoData.hourly && meteoData.hourly.us_aqi) {
      const latestIndex = meteoData.hourly.us_aqi.length - 1;
      aqi = meteoData.hourly.us_aqi[latestIndex];
    }

    //  Combine all the data into one object to return
    const data = {
      city: name,
      country,
      latitude: lat,
      longitude: lon,
      aqi,
      pm2_5: components.pm2_5 ?? "N/A",
      pm10: components.pm10 ?? "N/A",
      co: components.co ?? "N/A",
      no2: components.no2 ?? "N/A",
      o3: components.o3 ?? "N/A",
      so2: components.so2 ?? "N/A",
      uv_index: uvData.value ?? "N/A",
      // optional: timestamp of when we fetched
      fetchedAt: new Date().toISOString(),
    };

    // --------- 3) WRITE BACK TO CACHE WITH TTL ----------
    // set TTL for 24 hours from now (in seconds)
    const ttl = now + 24 * 60 * 60;

    await ddb.send(
      new PutCommand({
        TableName: CACHE_TABLE,
        Item: {
          cityKey, // partition key
          data,    // the payload we just built
          ttl,     // when DynamoDB should expire this item (TTL must be enabled in table with attribute name "ttl")
        },
      })
    );

    // return the final response with all the data
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data, source: "live" }),
    };
  } catch (error) {
    // If something goes wrong, return a server error
    console.error("Env Lambda Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: error.message || "Internal error" }),
    };
  }
};
