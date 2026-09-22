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

    const variables = {
      isActive: true,
      isArchived: false,
    };

    const response = await axios.post(
      EVERREAL_LISTINGS_URL,
      { query, variables },
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
    schema[field.name] = {
      id: field.id,
      type: field.type,
    };
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

  const newItem = await collection.addItems([
    {
      slug: slug,
      fieldData: fieldData,
    },
  ]);
  return newItem[0];
}

async function updateFramerItem(collectionId, itemId, slug, fieldData) {
  const framer = await getFramerConnection();
  const collection = await framer.getCollection(collectionId);
  if (!collection) throw new Error(`Collection ${collectionId} not found`);

  await collection.addItems([
    {
      id: itemId,
      slug: slug,
      fieldData: fieldData,
    },
  ]);
}

// ---- Build field entry (image handling unchanged) ----
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
    // Original behaviour: pass null (image issue is separate)
    return { type: type, value: null };
  }
  return null;
}

// ---- 4. Sync Logic ----
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
  };

  try {
    const token = await getEverRealToken();
    console.log('✅ Token obtained from EverReal.');

    const listings = await getActiveListings(token);
    stats.listingsFetched = listings.length;
    console.log(`📋 Fetched ${stats.listingsFetched} active listings from EverReal.`);

    const schema = await getCollectionSchema(FRAMER_COLLECTION_ID);
    const existingItems = await getFramerItems(FRAMER_COLLECTION_ID);

    const idFieldId = schema.id.id;
    const framerMap = new Map();
    existingItems.forEach((item) => {
      if (item.fieldData && item.fieldData[idFieldId]) {
        const listingId = item.fieldData[idFieldId].value;
        if (listingId) framerMap.set(listingId, item);
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
        if (entry) {
          fieldData[fieldInfo.id] = entry;
        }
      };

      // ---- Existing field mappings (unchanged) ----
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
      const picturesValue = listing.pictures?.map(p => p.resourcePath).join(', ') || '';
      addField('pictures_resourcePath', picturesValue);

      addField('descriptions_object', listing.descriptions?.object);
      addField('descriptions_amenities', listing.descriptions?.amenities);
      addField('descriptions_location', listing.descriptions?.location);
      addField('descriptions_other', listing.descriptions?.other);

      // ---- NEW: Generate Exposé URL from listing ID ----
      const exposeUrl = `https://wekagmbh.everreal.co/candidates/public/expose/${listingId}`;
      addField('virtualTourLink', exposeUrl);
      console.log(`🔗 Generated virtualTourLink for ${listingId}: ${exposeUrl}`);
      stats.virtualTourLinksSet++;
      // -------------------------------------------------

      try {
        if (framerMap.has(listingId)) {
          const existingItem = framerMap.get(listingId);
          await updateFramerItem(FRAMER_COLLECTION_ID, existingItem.id, listingId, fieldData);
          stats.updated++;
          console.log(`🔄 Updated listing ${listingId}`);
        } else {
          await createFramerItem(FRAMER_COLLECTION_ID, listingId, fieldData);
          stats.created++;
          console.log(`➕ Created listing ${listingId}`);
        }
      } catch (err) {
        console.error(`❌ Failed to process listing ${listingId}:`, err.message);
        console.error('📄 Field data sent:', JSON.stringify(fieldData, null, 2));
        if (err.stack) console.error('📄 Stack:', err.stack);
      }
    }

    // ---- Inactivate old listings (unchanged) ----
    const fetchedIds = new Set(listings.map(l => l.id));
    for (const [listingId, item] of framerMap) {
      if (!fetchedIds.has(listingId)) {
        const fieldData = {};
        const isActiveField = schema.isActive;
        const statusField = schema.status;
        if (isActiveField) {
          fieldData[isActiveField.id] = { type: 'boolean', value: false };
        }
        if (statusField) {
          fieldData[statusField.id] = { type: 'string', value: 'INACTIVE' };
        }
        try {
          await updateFramerItem(FRAMER_COLLECTION_ID, item.id, listingId, fieldData);
          stats.inactivated++;
          console.log(`🔕 Inactivated listing ${listingId}`);
        } catch (err) {
          console.error(`❌ Failed to inactivate listing ${listingId}:`, err.message);
        }
      }
    }

    console.log('✅ Sync completed!');
    console.log(`📊 Summary: ${stats.created} created, ${stats.updated} updated, ${stats.inactivated} inactivated, ${stats.virtualTourLinksSet} virtualTourLinks set.`);
    return stats;
  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    if (error.stack) console.error('📄 Stack trace:', error.stack);
    throw error;
  }
}

// ---- Framer Publish/Deploy ----
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

// ---- Disconnect helper ----
async function disconnectFramer() {
  if (framerConnection && typeof framerConnection.disconnect === 'function') {
    await framerConnection.disconnect();
    console.log('🔌 Disconnected from Framer.');
    framerConnection = null;
  }
}

// ---- Vercel Handler ----
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

