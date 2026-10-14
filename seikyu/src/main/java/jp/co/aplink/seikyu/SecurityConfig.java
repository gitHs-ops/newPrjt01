package jp.co.aplink.seikyu;
import org.springframework.context.annotation.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.http.HttpMethod;
import java.util.*;
@Configuration
public class SecurityConfig {
 @Bean org.springframework.security.crypto.password.PasswordEncoder passwordEncoder(){return new BCryptPasswordEncoder();}
 @Bean UserDetailsService users(@Value("${app.admin.username}")String user,@Value("${app.admin.password}")String password,@Value("${app.viewer.username}")String viewer,@Value("${app.viewer.password}")String viewerPassword){
  if(password.length()<16)throw new IllegalStateException("APLINK_ADMIN_PASSWORD must be set to at least 16 characters");
  var encoder=new BCryptPasswordEncoder();var users=new ArrayList<UserDetails>();users.add(User.withUsername(user).password(encoder.encode(password)).roles("ADMIN").build());
  if(!viewerPassword.isBlank()){if(viewerPassword.length()<16)throw new IllegalStateException("Viewer password too short");users.add(User.withUsername(viewer).password(encoder.encode(viewerPassword)).roles("VIEWER").build());}return new InMemoryUserDetailsManager(users);
 }
 @Bean SecurityFilterChain security(HttpSecurity http)throws Exception{
  return http.authorizeHttpRequests(a->a.requestMatchers("/login","/login.html","/login.js","/styles.css","/error").permitAll().requestMatchers(HttpMethod.POST,"/api/**").hasRole("ADMIN").anyRequest().authenticated())
   .formLogin(f->f.loginPage("/login.html").loginProcessingUrl("/login").defaultSuccessUrl("/",true).failureUrl("/login.html?error"))
   .logout(l->l.logoutSuccessUrl("/login.html"))
   .exceptionHandling(e->e.defaultAuthenticationEntryPointFor((request,response,ex)->response.sendError(401),r->r.getRequestURI().startsWith("/api/")))
   .headers(h->h.contentSecurityPolicy(c->c.policyDirectives("default-src 'self'; style-src 'self' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; script-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")))
   .build();
 }
}
