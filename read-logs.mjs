import parquet from 'parquetjs-lite';

const reader = await parquet.ParquetReader.openFile('storage/logs.parquet');
const cursor = reader.getCursor();
let row = await cursor.next();
let count = 0;
while (row && count < 15) {
  console.log(JSON.stringify(row, null, 2));
  row = await cursor.next();
  count++;
}
