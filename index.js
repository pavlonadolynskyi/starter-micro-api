const express = require('express');
const qs = require('qs');
const crypto = require('crypto');
const axios = require('axios');


const config = {
  host: 'https://openapi.tuyaeu.com',
  tuyaAccessKey: process.env.TUYA_KEY,
  tuyaSecretKey: process.env.TUYA_SECRET,
  switchDeviceId: process.env.TUYA_SWITCH_ID,
  measurerDeviceId: process.env.TUYA_MEASURER_ID,
  weatherKey: process.env.WEATHER_API_KEY,
  weatherLocation: process.env.WEATHER_LOCATION,
  minInsideTemperature: parseInt(process.env.MIN_INSIDE_TEMPERATURE, 10),
};

const httpClient = axios.create({
  baseURL: config.host,
});

let stateIsCooling = undefined;

async function main() {
  let newIsCooling = undefined;

  const tuyaToken = await getTuyaToken();

  const { temp: insideTemperature, timestamp: insideTimestamp } = await getInsideTemperature(tuyaToken, config.measurerDeviceId);
  const { temp: outsideTemperature, timestamp: outsideTimestamp } = await getOutsideTemperature(config.weatherKey, config.weatherLocation);

  const now = new Date()
  
  if (newIsCooling === undefined && insideTemperature <= config.minInsideTemperature) {
    newIsCooling = false;
  }
  if (newIsCooling === undefined) {
    newIsCooling = insideTemperature > outsideTemperature
  }
  const changeSwitch = newIsCooling !== stateIsCooling;
  console.log(`IN: ${insideTemperature} (-${new Date(now - insideTimestamp).getMinutes()}m) OUT: ${outsideTemperature} (-${new Date(now - outsideTimestamp).getMinutes()}m) ON: ${newIsCooling} CHANGED: ${changeSwitch}`);

  if (!changeSwitch) {
    return;
  }
  await setSwitcher(tuyaToken, config.switchDeviceId, newIsCooling);

  stateIsCooling = newIsCooling;
}

async function getTuyaToken() {
  const method = 'GET';
  const timestamp = Date.now().toString();
  const signUrl = '/v1.0/token?grant_type=1';
  const contentHash = crypto.createHash('sha256').update('').digest('hex');
  const stringToSign = [method, contentHash, '', signUrl].join('\n');
  const signStr = config.tuyaAccessKey + timestamp + stringToSign;

  const headers = {
    t: timestamp,
    sign_method: 'HMAC-SHA256',
    client_id: config.tuyaAccessKey,
    sign: await encryptStr(signStr, config.tuyaSecretKey),
  };
  const { data: login } = await httpClient.get('/v1.0/token?grant_type=1', { headers });
  if (!login || !login.success) {
    throw Error(`fetch failed: ${login.msg}`);
  }
  return login.result.access_token;
}

async function setSwitcher(token, deviceId, isOn) {
  const query = {};
  const method = 'POST';
  const url = `/v2.0/cloud/thing/${deviceId}/shadow/properties/issue`;
  const body = { properties: { switch_1: isOn } }
  const reqHeaders = await getRequestSign(token, url, method, {}, query, body);

  const { data } = await httpClient.request({
    method,
    data: body,
    params: {},
    headers: reqHeaders,
    url: reqHeaders.path,
  });
  if (!data || !data.success) {
    throw Error(`request api failed: ${JSON.stringify(data)}`);
  }
  return data
}

async function getDeviceProperties(token, deviceId) {
  const query = {};
  const method = 'GET';
  const url = `/v2.0/cloud/thing/${deviceId}/shadow/properties`;
  const reqHeaders = await getRequestSign(token, url, method, {}, query);

  const { data } = await httpClient.request({
    method,
    data: {},
    params: {},
    headers: reqHeaders,
    url: reqHeaders.path,
  });
  if (!data || !data.success) {
    throw Error(`request api failed: ${JSON.stringify(data)}`);
  }
  return data.result.properties
}

async function getOutsideTemperature(apiKey, location) {
  const { data } = await httpClient.request({
    method: 'GET',
    params: { key: apiKey, q: location, aqi: 'no'},
    url: 'http://api.weatherapi.com/v1/current.json',
  });
  return { temp: data.current.temp_c, timestamp: data.current.last_updated_epoch * 1000 }
}

async function getInsideTemperature(token, deviceId) {
  const properties = await getDeviceProperties(token, deviceId)
  const temperatureProperty = properties.find(p => p.code === 'temp_current')
  return { temp: temperatureProperty.value / 10, timestamp: temperatureProperty.time }
}

async function getIsSwitchOn(token, deviceId) {
  const properties = await getDeviceProperties(token, deviceId)
  const property = properties.find(p => p.code === 'switch_1')
  return property.value
}

/**
 * HMAC-SHA256 crypto function
 */
async function encryptStr(str, secret) {
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

/**
 * request sign, save headers 
 * @param path
 * @param method
 * @param headers
 * @param query
 * @param body
 */
async function getRequestSign(
  token,
  path,
  method,
  headers = {},
  query = {},
  body = {},
) {
  const t = Date.now().toString();
  const [uri, pathQuery] = path.split('?');
  const queryMerged = Object.assign(query, qs.parse(pathQuery));
  const sortedQuery = {};
  Object.keys(queryMerged)
    .sort()
    .forEach((i) => (sortedQuery[i] = query[i]));

  const querystring = decodeURIComponent(qs.stringify(sortedQuery));
  const url = querystring ? `${uri}?${querystring}` : uri;
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const stringToSign = [method, contentHash, '', url].join('\n');
  const signStr = config.tuyaAccessKey + token + t + stringToSign;
  return {
    t,
    path: url,
    client_id: config.tuyaAccessKey,
    sign: await encryptStr(signStr, config.tuyaSecretKey),
    sign_method: 'HMAC-SHA256',
    access_token: token,
  };
}

const app = express();

app.get('/', (req, res) => {
  const tuyaToken = await getTuyaToken();

  const { temp: insideTemperature, timestamp: insideTimestamp } = await getInsideTemperature(tuyaToken, config.measurerDeviceId);
  const { temp: outsideTemperature, timestamp: outsideTimestamp } = await getOutsideTemperature(config.weatherKey, config.weatherLocation);
  const isSwitchOn = await getIsSwitchOn(tuyaToken, config.switchDeviceId)
  const now = new Date()

  res.send(`IN: ${insideTemperature} (-${new Date(now - insideTimestamp).getMinutes()}m) OUT: ${outsideTemperature} (-${new Date(now - outsideTimestamp).getMinutes()}m) ON: ${isSwitchOn}`)
})

app.post('/check', async (req, res) => {
  await main()
  res.sendStatus(200)
})

app.listen(process.env.PORT || 3000, () => {
  console.log(`Example app listening on port ${port}`)
})
