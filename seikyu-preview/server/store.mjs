import {dispatch} from '../domain.mjs';
import {seed} from '../demo-store.mjs';

export class Conflict extends Error {}
export class MysqlStore {
  constructor(pool){this.pool=pool;}
  async initialize(){
    await this.pool.query(`CREATE TABLE IF NOT EXISTS preview_workspace (
      id INT PRIMARY KEY, revision BIGINT UNSIGNED NOT NULL,
      state_json JSON NOT NULL, updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ON UPDATE CURRENT_TIMESTAMP(6)) ENGINE=InnoDB`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS preview_audit (
      revision BIGINT UNSIGNED PRIMARY KEY, created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      actor VARCHAR(100) NOT NULL, action VARCHAR(60) NOT NULL) ENGINE=InnoDB`);
    const d=seed();
    await this.pool.execute('INSERT INTO preview_workspace (id,revision,state_json) VALUES (1,1,?) ON DUPLICATE KEY UPDATE id=id',[JSON.stringify(d.state)]);
  }
  decode(r){return {version:1,revision:Number(r.revision),state:typeof r.state_json==='string'?JSON.parse(r.state_json):r.state_json};}
  async read(){const [rows]=await this.pool.execute('SELECT revision,state_json FROM preview_workspace WHERE id=1');if(!rows.length)throw Error('Missing workspace');return this.decode(rows[0]);}
  async audit(){const [rows]=await this.pool.query('SELECT revision,created_at,actor,action FROM preview_audit ORDER BY revision DESC LIMIT 200');return rows;}
  async mutate(command,actor,reset=false){
    const c=await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows]=await c.execute('SELECT revision,state_json FROM preview_workspace WHERE id=1 FOR UPDATE');
      const current=this.decode(rows[0]);
      if(!Number.isSafeInteger(command.revision)||command.revision!==current.revision)throw new Conflict('他の利用者が更新しました。再読込してやり直してください。');
      const next=reset?{state:seed().state,result:{reset:true}}:dispatch(current.state,command,actor);
      const revision=current.revision+1;
      await c.execute('UPDATE preview_workspace SET revision=?,state_json=? WHERE id=1',[revision,JSON.stringify(next.state)]);
      await c.execute('INSERT INTO preview_audit (revision,actor,action) VALUES (?,?,?)',[revision,actor,reset?'demo.reset':command.action]);
      await c.commit();return {version:1,revision,...next};
    } catch(error){await c.rollback();throw error;}finally{c.release();}
  }
}
