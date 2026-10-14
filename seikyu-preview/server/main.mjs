import mysql from 'mysql2/promise';
import {MysqlStore} from './store.mjs';
import {serverFor} from './http.mjs';
const e=process.env;
for(const key of ['MYSQLHOST','MYSQLDATABASE','MYSQLUSER','MYSQLPASSWORD','DEMO_USER','DEMO_PASSWORD'])if(!e[key])throw Error('Missing environment variable: '+key);
const pool=mysql.createPool({host:e.MYSQLHOST,port:Number(e.MYSQLPORT||3306),database:e.MYSQLDATABASE,user:e.MYSQLUSER,password:e.MYSQLPASSWORD,charset:'utf8mb4',timezone:'Z',connectionLimit:5,queueLimit:30,connectTimeout:10000,...(e.MYSQL_SSL_CA?{ssl:{ca:e.MYSQL_SSL_CA,rejectUnauthorized:true}}:{})});
const store=new MysqlStore(pool);
const server=serverFor({store,user:e.DEMO_USER,password:e.DEMO_PASSWORD,assetRoot:new URL('../',import.meta.url)});
try{await store.initialize();server.listen(Number(e.PORT||8080),'0.0.0.0',()=>console.log('APLink MySQL preview ready'));}
catch(error){console.error('Startup failed:',error.code||error.name);await pool.end();process.exitCode=1;}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await pool.end();process.exit(0);}));
