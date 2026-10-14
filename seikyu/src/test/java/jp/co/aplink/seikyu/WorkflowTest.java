package jp.co.aplink.seikyu;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.jdbc.core.JdbcTemplate;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import java.util.*;

@SpringBootTest(properties={"spring.datasource.url=jdbc:h2:mem:tests;MODE=PostgreSQL;DB_CLOSE_DELAY=-1","app.admin.password=test-password-for-integration-only"})
@AutoConfigureMockMvc
class WorkflowTest {
 @Autowired WorkspaceService service;@Autowired ObjectMapper mapper;@Autowired JdbcTemplate jdbc;@Autowired MockMvc mvc;
 @BeforeEach void reset(){jdbc.update("DELETE FROM audit_event");jdbc.update("UPDATE workspace SET snapshot='{}',revision=0 WHERE id=1");}
 ObjectNode payload(Object... values){ObjectNode n=mapper.createObjectNode();for(int i=0;i<values.length;i+=2)n.set(values[i].toString(),mapper.valueToTree(values[i+1]));return n;}
 Map<String,Object> command(String action,JsonNode p){var body=payload("revision",service.read().get("revision"),"action",action,"payload",p);return service.command(body,"test");}
 String create(String action,JsonNode p){return ((JsonNode)command(action,p).get("result")).path("id").asText();}
 ObjectNode state(){return (ObjectNode)service.read().get("state");}
 String customer(){return create("master.save",payload("kind","customers","code","00001","name","テスト得意先","closing",20));}
 String item(){return create("master.save",payload("kind","items","code","001","name","テスト商品","price",100,"taxRate",10));}
 String vendor(){return create("master.save",payload("kind","vendors","code","001","name","テスト業者"));}
 String invoice(String customer){String item=item();create("shipment.save",payload("date","2026-10-01","customerId",customer,"itemId",item,"quantity","2.5","price","1000"));command("billing.create",payload("month","2026-10","closing",20,"customerIds",List.of(customer)));return state().path("invoices").get(0).path("id").asText();}
 @Test void decimalAndMonthBoundaries(){assertEquals(136598,Domain.amount("1","136598.99"));assertEquals(-1,Domain.amount("-0.15","10"));assertEquals("2024-02-01",Domain.period("2024-02",31)[0].toString());assertEquals("2024-02-29",Domain.period("2024-02",31)[1].toString());assertEquals("2025-12-21",Domain.period("2026-01",20)[0].toString());}
 @Test void billingIssuePartialReceiptAndFinalSettlement(){String c=customer(),inv=invoice(c);assertEquals(2750,state().path("invoices").get(0).path("total").asLong());command("invoice.issue",payload("ids",List.of(inv)));command("receipt.create",payload("date","2026-10-21","customerId",c,"bank",1000,"fee",100,"allocations",List.of(Map.of("invoiceId",inv,"amount",1100))));assertEquals(1100,state().path("invoices").get(0).path("paid").asLong());command("receipt.create",payload("date","2026-10-22","customerId",c,"bank",1650,"allocations",List.of(Map.of("invoiceId",inv,"amount",1650))));assertEquals(2750,state().path("invoices").get(0).path("paid").asLong());for(var j:state().path("journals")){long d=0,cr=0;for(var l:j.path("lines"))if(l.path("side").asText().equals("D"))d+=l.path("amount").asLong();else cr+=l.path("amount").asLong();assertEquals(d,cr);}}
 @Test void overpaymentAndFailedAllocationAreAtomic(){String c=customer(),inv=invoice(c);command("invoice.issue",payload("ids",List.of(inv)));var before=service.read();assertThrows(Domain.Invalid.class,()->command("receipt.create",payload("date","2026-10-21","customerId",c,"bank",9999,"allocations",List.of(Map.of("invoiceId",inv,"amount",9999)))));assertEquals(before,service.read());assertThrows(Domain.Invalid.class,()->command("receipt.create",payload("date","2026-10-21","customerId",c,"bank",1001,"allocations",List.of(Map.of("invoiceId",inv,"amount",1000)))));assertEquals(before,service.read());}
 @Test void duplicateBillingAndStaleRevisionRejected(){String c=customer();invoice(c);assertThrows(Domain.Invalid.class,()->command("billing.create",payload("month","2026-10","closing",20,"customerIds",List.of(c))));assertThrows(WorkspaceService.Conflict.class,()->service.command(payload("revision",0,"action","master.save","payload",payload()),"test"));}
 @Test void invoicePreservesHistoricalMasterNames(){String c=customer();invoice(c);command("master.save",payload("kind","customers","id",c,"code","00001","name","変更後の名称","closing",20));assertEquals("テスト得意先",state().path("invoices").get(0).path("customerName").asText());assertEquals("テスト商品",state().path("invoices").get(0).path("lines").get(0).path("itemName").asText());}
 @Test void postBillingShipmentCannotChange(){String c=customer();invoice(c);var old=state().path("shipments").get(0).deepCopy();((ObjectNode)old).put("quantity","999");assertThrows(Domain.Invalid.class,()->command("shipment.save",old));}
 @Test void inventoryReversesPreviousAndPaymentCannotExceedBill(){String v=vendor(),it=item();command("master.save",payload("kind","accounts","code","8231","name","原材料費"));String b=create("payable.create",payload("date","2026-10-20","vendorId",v,"amount",1000,"account","8231","taxCode","141","memo","原材料"));command("payment.create",payload("date","2026-10-21","payableId",b,"amount",600));assertThrows(Domain.Invalid.class,()->command("payment.create",payload("date","2026-10-21","payableId",b,"amount",401)));command("inventory.save",payload("month","2026-09","itemId",it,"quantity","10","price","200"));command("inventory.save",payload("month","2026-10","itemId",it,"quantity","8","price","200"));assertEquals(2000,state().path("inventory").get(1).path("previous").asLong());assertEquals(4,state().path("journals").get(3).path("lines").size());}
 @Test void csvImportRollsBackEntireBatch(){var before=service.read();assertThrows(Domain.Invalid.class,()->command("master.import",payload("kind","customers","rows",List.of(Map.of("code","01","name","one","closing",20),Map.of("code","01","name","duplicate","closing",20)))));assertEquals(before,service.read());}
 @Test void unknownRulesAreBlocked(){String c=customer(),it=item();command("shipment.save",payload("date","2026-10-01","customerId",c,"itemId",it,"quantity","-1","price","100"));assertThrows(Domain.Invalid.class,()->command("billing.create",payload("month","2026-10","closing",20,"customerIds",List.of(c))));assertEquals(0,state().path("invoices").size());}
 @Test void closedMonthRejectsNewTransactions(){String c=customer(),it=item();command("month.close",payload("month","2026-09"));assertThrows(Domain.Invalid.class,()->command("shipment.save",payload("date","2026-09-01","customerId",c,"itemId",it,"quantity","1","price","100")));}
 @Test void unauthenticatedAccessIsDenied()throws Exception{mvc.perform(get("/api/workspace")).andExpect(status().isUnauthorized());}
 @Test void realPasswordLoginWorks()throws Exception{mvc.perform(post("/login").with(csrf()).param("username","admin").param("password","test-password-for-integration-only")).andExpect(status().is3xxRedirection()).andExpect(redirectedUrl("/"));}
 @Test @WithMockUser(roles="VIEWER") void viewerCannotWrite()throws Exception{mvc.perform(post("/api/workspace").with(csrf()).contentType("application/json").content("{}")).andExpect(status().isForbidden());}
 @Test @WithMockUser(roles="ADMIN") void csrfRequired()throws Exception{mvc.perform(post("/api/workspace").contentType("application/json").content("{}")).andExpect(status().isForbidden());}
 @Test @WithMockUser(roles="ADMIN") void spreadsheetIsRealXlsx()throws Exception{customer();byte[] bytes=mvc.perform(get("/api/export/customers.xlsx")).andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();try(var book=new org.apache.poi.xssf.usermodel.XSSFWorkbook(new java.io.ByteArrayInputStream(bytes))){assertEquals("00001",book.getSheetAt(0).getRow(1).getCell(1).getStringCellValue());}}
}
