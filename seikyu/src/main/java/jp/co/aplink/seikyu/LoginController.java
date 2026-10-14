package jp.co.aplink.seikyu;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.web.csrf.CsrfToken;
import java.util.Map;
@RestController
public class LoginController {
 @GetMapping("/login") public Map<String,String> csrf(CsrfToken token){return Map.of("token",token.getToken(),"parameter",token.getParameterName());}
}
