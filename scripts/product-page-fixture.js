/* Injected only by the local rehearsal server. Never writes to a live service. */
window.fetch=async url=>{
  if(String(url).includes('/rest/v1/products?'))return Response.json([{id:1,Name:'Havells ZEN 1100 W Dry Iron — Blue',Brand:'Havells',Category:'Appliances',Price:'',in_stock:false,Photo_url:'/__photo.jpg',Spec:'Description\nA heavy-weight dry iron for everyday ironing.\n\nFeatures\n• Powerful 1100 W heating — Fast heating and even heat distribution.\n• Cool-touch body — A 1.4 kg iron with a comfortable plastic body.\n• Greblon non-stick soleplate — Smooth gliding over fabrics.\n\nTechnical specifications\nVoltage: 240 V\nCord length: 1.7 m\nWattage: 1100 W\nCountry of origin: India'}]);
  if(String(url).includes('/rest/v1/product_images?'))return Response.json([{image_url:'/__photo.jpg'}]);
  if(String(url).includes('/rest/v1/product_variants?'))return Response.json([]);
  throw Error('External requests disabled in local product fixture');
};
