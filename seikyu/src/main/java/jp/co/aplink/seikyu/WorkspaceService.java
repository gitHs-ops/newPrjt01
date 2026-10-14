package jp.co.aplink.seikyu;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.Instant;
import java.util.*;
@Service
public class WorkspaceService {
 private final JdbcTemplate jdbc;private final ObjectMapper mapper;private final Domain domain;
 public WorkspaceService(JdbcTemplate j,ObjectMapper m){jdbc=j;mapper=m;domain=new Domain(m);}
 public Map<String,Object> read(){var r=jdbc.queryForMap("SELECT revision,snapshot FROM workspace WHERE id=1");return Map.of("revision",r.get("revision"),"state",parse(r.get("snapshot").toString()));}
 private ObjectNode parse(String text){try{ObjectNode n=(ObjectNode)mapper.readTree(text);return n.has("schemaVersion")?n:domain.fresh();}catch(Exception e){throw new IllegalStateException("Invalid workspace state",e);}}
 @Transactional public Map<String,Object> command(JsonNode body,String actor){
  var row=jdbc.queryForMap("SELECT revision,snapshot FROM workspace WHERE id=1 FOR UPDATE");long rev=((Number)row.get("revision")).longValue();
  if(!body.path("revision").isIntegralNumber()||body.path("revision").asLong()!=rev)throw new Conflict("別の画面で更新されました。再読込してください。");
  ObjectNode state=parse(row.get("snapshot").toString());String action=body.path("action").asText();JsonNode result=domain.execute(state,action,body.path("payload"));String now=Instant.now().toString();
  jdbc.update("UPDATE workspace SET snapshot=?,revision=?,updated_at=? WHERE id=1",state.toString(),rev+1,now);
  jdbc.update("INSERT INTO audit_event(revision,actor,action,created_at,result) VALUES(?,?,?,?,?)",rev+1,actor,action,now,result.toString());return Map.of("state",state,"revision",rev+1,"result",result);
 }
 public List<Map<String,Object>> audit(){return jdbc.queryForList("SELECT revision,actor,action,created_at,result FROM audit_event ORDER BY revision DESC FETCH FIRST 200 ROWS ONLY");}
 public static class Conflict extends RuntimeException{Conflict(String m){super(m);}}
}
