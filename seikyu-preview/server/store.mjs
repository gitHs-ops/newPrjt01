import {dispatch} from '../domain.mjs';
import {seed} from '../demo-store.mjs';
import {DomainError} from '../domain.mjs';
import {ensureMasterLinks,hydrate,migrateMasters,persistMasters,withoutMasters} from './masters.mjs';

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
    await ensureMasterLinks(this.pool);
    const c=await this.pool.getConnection();
    try{
      await c.beginTransaction();
      const [rows]=await c.query('SELECT revision,state_json FROM preview_workspace WHERE id=1 FOR UPDATE');
      const current=this.decode(rows[0]);
      if(current.state.masterStorage!=='tables-v1'){
        await migrateMasters(c,current.state);
        await c.execute('UPDATE preview_workspace SET state_json=?,revision=? WHERE id=1',[JSON.stringify(withoutMasters(current.state)),current.revision+1]);
        await c.execute('INSERT INTO preview_audit (revision,actor,action) VALUES (?,?,?)',[current.revision+1,'system','master.migrate']);
      }
      await c.commit();
    }catch(e){await c.rollback();throw e;}finally{c.release();}
  }
  decode(r){return {version:1,revision:Number(r.revision),state:typeof r.state_json==='string'?JSON.parse(r.state_json):r.state_json};}
  async read(){const c=await this.pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute('SELECT revision,state_json FROM preview_workspace WHERE id=1');if(!rows.length)throw Error('Missing workspace');const data=this.decode(rows[0]);await hydrate(c,data.state);await c.commit();return data;}catch(e){await c.rollback();throw e;}finally{c.release();}}
  async audit(){const [rows]=await this.pool.query('SELECT revision,created_at,actor,action FROM preview_audit ORDER BY revision DESC LIMIT 200');return rows;}
  async mutate(command,actor,reset=false){
    if(reset)throw new DomainError('個別マスタへの移行後は共有データの一括初期化を無効にしています。');
    const c=await this.pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows]=await c.execute('SELECT revision,state_json FROM preview_workspace WHERE id=1 FOR UPDATE');
      const current=this.decode(rows[0]);
      if(!Number.isSafeInteger(command.revision)||command.revision!==current.revision)throw new Conflict('他の利用者が更新しました。再読込してやり直してください。');
      await hydrate(c,current.state);
      const next=dispatch(current.state,command,actor);
      await persistMasters(c,current.state,next.state);
      const revision=current.revision+1;
      await c.execute('UPDATE preview_workspace SET revision=?,state_json=? WHERE id=1',[revision,JSON.stringify(withoutMasters(next.state))]);
      await c.execute('INSERT INTO preview_audit (revision,actor,action) VALUES (?,?,?)',[revision,actor,reset?'demo.reset':command.action]);
      await c.commit();return {version:1,revision,...next};
    } catch(error){await c.rollback();if(error.code==='ER_DUP_ENTRY')throw new DomainError('コードまたは口座が重複しています');throw error;}finally{c.release();}
  }
}
