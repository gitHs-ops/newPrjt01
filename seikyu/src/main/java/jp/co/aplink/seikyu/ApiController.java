package jp.co.aplink.seikyu;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.core.Authentication;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import java.io.*;
import java.util.*;

@RestController
public class ApiController {
 private final WorkspaceService service;private final ObjectMapper mapper;
 public ApiController(WorkspaceService s,ObjectMapper m){service=s;mapper=m;}
 @GetMapping("/api/session") Map<String,Object> session(Authentication auth,CsrfToken csrf){return Map.of("user",auth.getName(),"canWrite",auth.getAuthorities().stream().anyMatch(a->a.getAuthority().equals("ROLE_ADMIN")),"csrf",csrf.getToken(),"header",csrf.getHeaderName());}
 @GetMapping("/api/workspace") Map<String,Object> read(){return service.read();}
 @PostMapping("/api/workspace") Map<String,Object> save(@RequestBody String raw,Authentication auth)throws IOException{if(raw.length()>500000)throw new Domain.Invalid("取込サイズは500KBまでです");return service.command(mapper.readTree(raw),auth.getName());}
 @GetMapping("/api/audit") List<Map<String,Object>> audit(){return service.audit();}
 @GetMapping("/api/export/{kind}.xlsx") ResponseEntity<byte[]> export(@PathVariable String kind)throws IOException{
  var state=(ObjectNode)service.read().get("state");List<String> supported=List.of("customers","vendors","items","banks","accounts","subaccounts","shipments","invoices","receipts","purchases","inventory","payables","cash","payments","journals");Domain.require(supported.contains(kind),"出力対象が不正です");var records=new ArrayList<JsonNode>();
  if(kind.equals("journals")){for(var j:state.path(kind))for(var l:j.path("lines")){ObjectNode r=l.deepCopy();r.put("journal",j.path("id").asText()).put("date",j.path("date").asText()).put("pattern",j.path("pattern").asText()).put("source",j.path("source").asText());records.add(r);}}else state.path(kind).forEach(records::add);
  var columns=new LinkedHashSet<String>();records.forEach(r->r.fieldNames().forEachRemaining(columns::add));
  try(var book=new XSSFWorkbook();var bytes=new ByteArrayOutputStream()){var sheet=book.createSheet(kind);var header=sheet.createRow(0);int ci=0;for(String key:columns)header.createCell(ci++).setCellValue(key);int ri=1;for(var record:records){var row=sheet.createRow(ri++);ci=0;for(String key:columns){var value=record.path(key);var cell=row.createCell(ci++);if(value.isNumber())cell.setCellValue(value.asDouble());else cell.setCellValue(value.isContainerNode()?value.toString():value.asText(""));}}sheet.createFreezePane(0,1);for(int i=0;i<columns.size();i++)sheet.setColumnWidth(i,22*256);book.write(bytes);return ResponseEntity.ok().header("Content-Disposition","attachment; filename=\""+kind+".xlsx\"").contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).body(bytes.toByteArray());}
 }
 @ExceptionHandler(Domain.Invalid.class) ResponseEntity<?> invalid(Domain.Invalid e){return ResponseEntity.badRequest().body(Map.of("error",e.getMessage()));}
 @ExceptionHandler(WorkspaceService.Conflict.class) ResponseEntity<?> conflict(WorkspaceService.Conflict e){return ResponseEntity.status(409).body(Map.of("error",e.getMessage()));}
 @ExceptionHandler(com.fasterxml.jackson.core.JsonProcessingException.class) ResponseEntity<?> json(){return ResponseEntity.badRequest().body(Map.of("error","JSON形式が不正です"));}
}
