export const maxDuration = 300;

const axios = require('axios');
require('dotenv').config();

// ---- Configuration ----
const FRAMER_PROJECT_URL = process.env.FRAMER_PROJECT_URL;
const FRAMER_API_KEY = process.env.FRAMER_API_KEY;
const FRAMER_COLLECTION_ID = process.env.FRAMER_COLLECTION_ID;
const EVERREAL_TOKEN_URL = process.env.EVERREAL_TOKEN_URL;
const EVERREAL_CLIENT_ID = process.env.EVERREAL_CLIENT_ID;
const EVERREAL_CLIENT_SECRET = process.env.EVERREAL_CLIENT_SECRET;
const EVERREAL_LISTINGS_URL = process.env.EVERREAL_LISTINGS_URL;

// ---- 1. Get EverReal Access Token ----
async function getEverRealToken() {
  try {
    const response = await axios.post(EVERREAL_TOKEN_URL, {
      username: process.env.EVERREAL_USERNAME,
      password: process.env.EVERREAL_PASSWORD,
      client_id: process.env.EVERREAL_CLIENT_ID,
      client_secret: process.env.EVERREAL_CLIENT_SECRET,
      grant_type: 'password',
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Error fetching token:', error.response?.data || error.message);
    throw error;
  }
}

// ---- 2. Fetch Active Listings from EverReal ----
async function getActiveListings(token) {
  try {
    const query = `
      query ListingsQuery($isActive: Boolean, $isArchived: Boolean) {
        listings(
          input: {
            paging: { take: 1000, skip: 0 }
            filter: {
              isActive: $isActive
              isArchived: $isArchived
            }
          }
        ) {
          id
          title
          type
          status
          isActive
          availableFrom
          contractDetails {
            currency
            rent
            totalMonthlyRent
            displayAmount
          }
          property {
            fullAddress
          }
          unit {
            livingSurface
            rooms {
              rooms
            }
          }
          coverPicture {
            resourcePath
          }
          pictures {
            resourcePath
          }
          descriptions {
            object
            amenities
            location
            other
          }
        }
      }
    `;

    const response = await axios.post(
      EVERREAL_LISTINGS_URL,
      { query, variables: { isActive: true, isArchived: false } },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data?.data?.listings || [];
  } catch (error) {
    console.error('Error fetching listings:', error.response?.data || error.message);
    throw error;
  }
}

// ---- 3. Framer SDK Operations ----
let framerConnection;
let fieldSchema = null;

async function getFramerConnection() {
  if (!framerConnection) {
    console.log('🔌 Connecting to Framer project...');
    const framerModule = await import('framer-api');
    const connect = framerModule.connect;
    framerConnection = await connect(FRAMER_PROJECT_URL, FRAMER_API_KEY);
    console.log('✅ Connected to Framer project');
  }
  return framerConnection;
}

async function getCollectionSchema(collectionId) {
  if (fieldSchema) return fieldSchema;
  const framer = await getFramerConnection();
  const collection = await framer.getCollection(collectionId);
  if (!collection) throw new Error(`Collection ${collectionId} not found`);
  const fields = await collection.getFields();
  const schema = {};
  fields.forEach((field) => {
    schema[field.name] = { id: field.id, type: field.type };
  });
  fieldSchema = schema;
  console.log('📋 Field schema:', schema);
  return schema;
}

async function getFramerItems(collectionId) {
  const framer = await getFramerConnection();
  const collection = await framer.getCollection(collectionId);
  if (!collection) throw new Error(`Collection ${collectionId} not found`);
  const items = await collection.getItems();
  console.log(`📁 Found ${items.length} existing items in Framer collection`);
  return items;
}

async function createFramerItem(collectionId, slug, fieldData) {
  const framer = await getFramerConnection();
  const collection = await framer.getCollection(collectionId);
  if (!collection) throw new Error(`Collection ${collectionId} not found`);
  const newItem = await collection.addItems([{ slug, fieldData }]);
  return newItem[0];
}

// CHANGED: only include slug in the payload if one is passed.
// Pass null/undefined to preserve the existing slug (used for inactivation).
async function updateFramerItem(collectionId, itemId, slug, fieldData) {
  const framer = await getFramerConnection();
  const collection = await framer.getCollection(collectionId);
  if (!collection) throw new Error(`Collection ${collectionId} not found`);
  const payload = { id: itemId, fieldData };
  if (slug) payload.slug = slug;
  await collection.addItems([payload]);
}

// Build field entry (unchanged)
function buildFieldEntry(fieldInfo, value) {
  const type = fieldInfo.type;
  if (type === 'string') {
    return { type: 'string', value: value !== undefined && value !== null ? String(value) : '' };
  }
  if (type === 'number') {
    const num = typeof value === 'number' ? value : Number(value);
    return { type: 'number', value: isNaN(num) ? 0 : num };
  }
  if (type === 'boolean') {
    return { type: 'boolean', value: value ?? true };
  }
  if (type === 'date') {
    return { type: 'date', value: value || null };
  }
  if (type === 'image' || type === 'file') {
    return { type: type, value: null };
  }
  return null;
}

// =====================================================================
// NEW: Slug helpers (this is the ONLY new logic)
// =====================================================================

function isUuid(slug) {
  return !!slug && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
}

function isReadableSlug(slug) {
  return !!slug && !isUuid(slug) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

function normalizeGerman(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function typeToNoun(type) {
  const map = {
    RENT_APARTMENT: 'wohnung',
    SELL_APARTMENT: 'wohnung',
    RENT_HOUSE: 'haus',
    SELL_HOUSE: 'haus',
    RENT_OFFICE: 'buero',
    RENT_STORE: 'ladenflaeche',
    RENT_PARKING: 'stellplatz',
    SELL_RESIDENTIAL_LAND: 'grundstueck',
  };
  return map[type] || 'immobilie';
}

function parseAddress(fullAddress) {
  const full = String(fullAddress || '').trim();
  const comma = full.indexOf(',');
  let street = '';
  let city = '';
  if (comma > -1) {
    street = full.slice(0, comma).trim();
    const tail = full.slice(comma + 1).trim();
    const m = tail.match(/^\d{5}\s+(.+)$/);
    city = (m ? m[1] : tail).replace(/^Gemeinde\s+/i, '').trim();
  } else {
    const m = full.match(/(\d{5})\s+(.+)$/);
    if (m) {
      city = m[2].replace(/^Gemeinde\s+/i, '').trim();
      street = full.slice(0, full.indexOf(m[0])).replace(/,\s*$/, '').trim();
    } else {
      street = full;
    }
  }
  return { street, city };
}

function buildBaseSlug(listing) {
  const { street, city } = parseAddress(listing.property?.fullAddress);
  let useStreet = street;
  if (!useStreet) {
    const parts = String(listing.title || '').split('|');
    useStreet = parts[parts.length - 1].trim();
  }
  const parts = [typeToNoun(listing.type), normalizeGerman(city), normalizeGerman(useStreet)].filter(Boolean);
  if (parts.length === 0) {
    return `listing-${String(listing.id).slice(0, 8)}`;
  }
  return parts.join('-');
}

function uniqueSlug(baseSlug, listing, reserved) {
  if (!reserved.has(baseSlug)) return baseSlug;
  const rooms = listing.unit?.rooms?.rooms;
  if (rooms) {
    const c = `${baseSlug}-${rooms}-zimmer`;
    if (!reserved.has(c)) return c;
  }
  const area = listing.unit?.livingSurface;
  if (area) {
    const c = `${baseSlug}-${Math.round(area)}-qm`;
    if (!reserved.has(c)) return c;
  }
  const uuid = String(listing.id).replace(/-/g, '');
  for (let len = 8; len <= uuid.length; len += 2) {
    const c = `${baseSlug}-${uuid.slice(0, len)}`;
    if (!reserved.has(c)) return c;
  }
  return `${baseSlug}-${uuid}`;
}

// =====================================================================
// Sync (only slug lines changed)
// =====================================================================

async function sync() {
  console.log('🔄 Starting sync...');

  if (!FRAMER_PROJECT_URL || !FRAMER_PROJECT_URL.startsWith('https://')) {
    throw new Error('FRAMER_PROJECT_URL is missing or invalid.');
  }

  const stats = {
    listingsFetched: 0,
    existingItems: 0,
    created: 0,
    updated: 0,
    inactivated: 0,
    virtualTourLinksSet: 0,
    slugsMigrated: 0,    // NEW
    slugsPreserved: 0,   // NEW
  };

  try {
    const token = await getEverRealToken();
    console.log('✅ Token obtained from EverReal.');

    const listings = await getActiveListings(token);
    stats.listingsFetched = listings.length;
    console.log(`📋 Fetched ${stats.listingsFetched} active listings from EverReal.`);

    const schema = await getCollectionSchema(FRAMER_COLLECTION_ID);
    const existingItems = await getFramerItems(FRAMER_COLLECTION_ID);
    stats.existingItems = existingItems.length;

    const idFieldId = schema.id.id;
    const framerMap = new Map();

    // NEW: track every readable slug already in the collection so we don't collide
    const reservedSlugs = new Set();

    existingItems.forEach((item) => {
      if (item.fieldData && item.fieldData[idFieldId]) {
        const listingId = item.fieldData[idFieldId].value;
        if (listingId) framerMap.set(listingId, item);
      }
      if (isReadableSlug(item.slug)) {
        reservedSlugs.add(item.slug);
      }
    });

    console.log(`📊 Found ${framerMap.size} existing items with matching IDs`);

    for (const listing of listings) {
      const listingId = String(listing.id);
      const fieldData = {};

      const addField = (fieldName, value) => {
        const fieldInfo = schema[fieldName];
        if (!fieldInfo) {
          console.warn(`⚠️ Field "${fieldName}" not found in schema, skipping.`);
          return;
        }
        const entry = buildFieldEntry(fieldInfo, value);
        if (entry) fieldData[fieldInfo.id] = entry;
      };

      // ---- Field mappings (unchanged) ----
      addField('id', listingId);
      addField('title', listing.title);
      addField('type', listing.type);
      addField('status', listing.status);
      addField('isActive', listing.isActive);
      addField('availableFrom', listing.availableFrom);
      addField('contractDetails_currency', listing.contractDetails?.currency);
      addField('contractDetails_rent', listing.contractDetails?.rent);
      addField('contractDetails_totalMonthlyRent', listing.contractDetails?.totalMonthlyRent);
      addField('contractDetails_displayAmount', listing.contractDetails?.displayAmount);
      addField('property_fullAddress', listing.property?.fullAddress);
      addField('unit_livingSurface', listing.unit?.livingSurface);
      addField('unit_rooms_rooms', listing.unit?.rooms?.rooms);
      addField('coverPicture_resourcePath', listing.coverPicture?.resourcePath);
      addField('pictures_resourcePath', listing.pictures?.map(p => p.resourcePath).join(', ') || '');
      addField('descriptions_object', listing.descriptions?.object);
      addField('descriptions_amenities', listing.descriptions?.amenities);
      addField('descriptions_location', listing.descriptions?.location);
      addField('descriptions_other', listing.descriptions?.other);

      // VirtualTourLink (unchanged)
      const exposeUrl = `https://wekagmbh.everreal.co/candidates/public/expose/${listingId}`;
      addField('virtualTourLink', exposeUrl);
      console.log(`🔗 Generated virtualTourLink for ${listingId}: ${exposeUrl}`);
      stats.virtualTourLinksSet++;

      // ---- NEW: decide what slug to write ----
      const existingItem = framerMap.get(listingId);
      let slugToWrite = null;

      if (existingItem && isReadableSlug(existingItem.slug)) {
        // Already SEO-friendly → preserve exactly
        slugToWrite = existingItem.slug;
        stats.slugsPreserved++;
      } else {
        // UUID or empty → generate readable slug
        const base = buildBaseSlug(listing);
        const candidate = uniqueSlug(base, listing, reservedSlugs);
        reservedSlugs.add(candidate);
        slugToWrite = candidate;
        stats.slugsMigrated++;
        if (existingItem) {
          console.log(`🔧 Slug migration for ${listingId}: "${existingItem.slug || '(empty)'}" → "${candidate}"`);
        }
      }
      // --------------------------------------------

      try {
        if (existingItem) {
          await updateFramerItem(FRAMER_COLLECTION_ID, existingItem.id, slugToWrite, fieldData);
          stats.updated++;
          console.log(`🔄 Updated listing ${listingId} (slug: ${slugToWrite})`);
        } else {
          await createFramerItem(FRAMER_COLLECTION_ID, slugToWrite, fieldData);
          stats.created++;
          console.log(`➕ Created listing ${listingId} (slug: ${slugToWrite})`);
        }
      } catch (err) {
        console.error(`❌ Failed to process listing ${listingId}:`, err.message);
        console.error('📄 Field data sent:', JSON.stringify(fieldData, null, 2));
        if (err.stack) console.error('📄 Stack:', err.stack);
      }
    }

    // ---- Inactivate old listings (unchanged, except slug NOT touched) ----
    const fetchedIds = new Set(listings.map(l => l.id));
    for (const [listingId, item] of framerMap) {
      if (!fetchedIds.has(listingId)) {
        const fieldData = {};
        if (schema.isActive) {
          fieldData[schema.isActive.id] = { type: 'boolean', value: false };
        }
        if (schema.status) {
          fieldData[schema.status.id] = { type: 'string', value: 'INACTIVE' };
        }
        try {
          // CHANGED: pass null so the existing slug is NOT overwritten on inactivation
          await updateFramerItem(FRAMER_COLLECTION_ID, item.id, null, fieldData);
          stats.inactivated++;
          console.log(`🔕 Inactivated listing ${listingId}`);
        } catch (err) {
          console.error(`❌ Failed to inactivate listing ${listingId}:`, err.message);
        }
      }
    }

    console.log('✅ Sync completed!');
    console.log(`📊 Summary: ${stats.created} created, ${stats.updated} updated, ${stats.inactivated} inactivated, ${stats.virtualTourLinksSet} virtualTourLinks set, ${stats.slugsMigrated} slugs migrated, ${stats.slugsPreserved} slugs preserved.`);
    return stats;
  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    if (error.stack) console.error('📄 Stack trace:', error.stack);
    throw error;
  }
}

// ---- Framer Publish/Deploy (unchanged) ----
async function publishFramerProject() {
  const framer = await getFramerConnection();
  console.log('📤 Publishing Framer project...');
  const result = await framer.publish();
  const deploymentId = result.deployment.id;
  console.log(`✅ Published. Deployment ID: ${deploymentId}`);
  return deploymentId;
}

async function deployFramerProject(deploymentId) {
  const framer = await getFramerConnection();
  console.log(`🚀 Deploying deployment ${deploymentId}...`);
  await framer.deploy(deploymentId);
  console.log(`✅ Deployment ${deploymentId} is live.`);
}

async function disconnectFramer() {
  if (framerConnection && typeof framerConnection.disconnect === 'function') {
    await framerConnection.disconnect();
    console.log('🔌 Disconnected from Framer.');
    framerConnection = null;
  }
}

// ---- Vercel Handler (unchanged) ----
module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    console.log('🔄 Vercel cron: Starting sync...');
    const stats = await sync();
    console.log('✅ Vercel cron: Sync completed successfully.');

    if (stats.created > 0 || stats.updated > 0 || stats.inactivated > 0) {
      console.log(`📊 Changes detected: ${stats.created} created, ${stats.updated} updated, ${stats.inactivated} inactivated.`);
      const deploymentId = await publishFramerProject();
      await deployFramerProject(deploymentId);
    } else {
      console.log('ℹ️ No changes detected; skipping publish.');
    }

    res.status(200).json({
      message: 'Sync completed successfully',
      stats: stats,
    });
  } catch (error) {
    console.error('❌ Vercel cron: Sync failed:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    await disconnectFramer();
  }
};
