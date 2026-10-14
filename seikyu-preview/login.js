document.querySelector('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),error=document.querySelector('#login-error');
  button.disabled=true;error.textContent='';
  try{
    const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Request':'1'},body:JSON.stringify({user:form.elements.user.value,password:form.elements.password.value})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'ログインできませんでした');
    location.replace('/'+location.hash);
  }catch(e){error.textContent=e.message;form.elements.password.value='';form.elements.password.focus();}finally{button.disabled=false;}
});
