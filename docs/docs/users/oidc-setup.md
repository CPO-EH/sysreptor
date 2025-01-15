# SSO Setup with OIDC
<span style="color:red;">:octicons-heart-fill-24: Pro only</span>

1. Configure your Identity Provider (IDP) and add configuration details to your `app.env`
    * [Microsoft Entra ID](../users/oidc-entra-id.md)
    * [Google Workplace/Google Identity](../users/oidc-google.md)
    * [Keycloak](../users/oidc-keycloak.md)
    * [Generic OIDC setup](../users/oidc-generic.md)
    * Need documentation for another IDP? Drop us a message at [GitHub Discussions](https://github.com/Syslifters/sysreptor/discussions/categories/ideas){ target=_blank }!
3. Restart containers using `docker-compose up -d` in `deploy` directory
2. Set up local users:

    a. Create user that should use SSO  
    b. Go to "Identities"  
    c. Add identity ("Add")  
    d. Select Provider and enter the email address used at your IDP (note: the identifier is case sensitive and has to be the same case as in the SSO provider)

![Add SSO identity](../images/add_identity.png)

The user can now login via his IDP.
